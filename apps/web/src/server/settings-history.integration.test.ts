/**
 * The settings change history as the browser actually drives it, against a real database (Issue #30).
 *
 * `settings-view.test.ts` proves the cursor codec in isolation and the store's own suite proves the
 * query. Neither proves the thing in between, which is exactly what the R5 finding on PR #79 was: the
 * read took the newest twenty, the store offered no continuation and the screen rendered no link, so a
 * business with twenty-one changes could read twenty of them with nothing on screen to say otherwise.
 * Every piece was correct and the history was unreachable.
 *
 * So this walks the loop the browser walks — read a page, follow the href the screen produced, read the
 * next — and asserts the property a paging bug always violates: every change appears exactly once.
 */
import {
  authorizeBusinessProfileAccess,
  authorizeWorkspaceAccess,
  createBusinessProfile,
  createWorkspaceWithOwner,
  listPolicyAudits,
  readPolicies,
  savePolicy,
  type BusinessProfileContext,
} from "@omnichannel/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { auditHistoryHref, decodeAuditCursor, one, policyChangeDiff } from "./settings-view";
import type { RawSearchParams } from "./inbox-view";

const BASE = "/workspaces/ws/profiles/bp/settings";

/** Twenty-one would prove the boundary; twenty-five also proves the pages after it join up. */
const CHANGES = 25;

describe.skipIf(!databaseTestsEnabled())("the settings change history", () => {
  let database: TestDatabase;
  let context: BusinessProfileContext;
  let neighbour: BusinessProfileContext;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    const db = database.db;

    const owner = await db.user.create({ data: { name: "Settings History Owner", email: "settings-history@example.test" } });
    const { workspaceId } = await createWorkspaceWithOwner(db, { name: "Settings History Workspace", ownerUserId: owner.id });
    const workspace = await authorizeWorkspaceAccess(db, { userId: owner.id, workspaceId });
    const profile = await createBusinessProfile(db, workspace, { name: "Main" });
    context = await authorizeBusinessProfileAccess(db, { userId: owner.id, workspaceId, businessProfileId: profile.businessProfileId });

    const other = await db.user.create({ data: { name: "Another Owner", email: "settings-history-other@example.test" } });
    const theirWorkspace = await createWorkspaceWithOwner(db, { name: "Another Workspace", ownerUserId: other.id });
    const theirs = await authorizeWorkspaceAccess(db, { userId: other.id, workspaceId: theirWorkspace.workspaceId });
    const theirProfile = await createBusinessProfile(db, theirs, { name: "Theirs" });
    neighbour = await authorizeBusinessProfileAccess(db, {
      userId: other.id,
      workspaceId: theirWorkspace.workspaceId,
      businessProfileId: theirProfile.businessProfileId,
    });

    for (const [target, label] of [
      [context, "ours"],
      [neighbour, "theirs"],
    ] as const) {
      // No policy row created here: `createBusinessProfile` writes the profile default in the same
      // statement as the profile, so these saves start from the policy a real profile has.
      for (let index = 0; index < CHANGES; index += 1) {
        // Through the real save, so each row is a change somebody actually made — and each carries the
        // version the previous one produced, which is the contract the screen's form obeys too.
        const current = (await readPolicies(database.db, target)).find((policy) => policy.channelAccountId === null);
        const outcome = await savePolicy(database.db, target, null, {
          expectedVersion: current?.version ?? 1,
          businessGoal: `${label} change ${String(index).padStart(2, "0")}`,
        });
        if (outcome.status !== "SAVED") {
          throw new Error(`the fixture expected SAVED, got ${outcome.status}`);
        }
      }
    }
  }, 300_000);

  afterAll(async () => {
    await database?.dispose();
  });

  /** One request, as the screen handles it: a query in, a page of entries and a next link out. */
  const screen = async (
    query: RawSearchParams,
    who: BusinessProfileContext = context,
  ): Promise<{ readonly ids: readonly string[]; readonly goals: readonly string[]; readonly nextHref?: string }> => {
    const page = await listPolicyAudits(database.db, who, {
      limit: 20,
      ...(decodeAuditCursor(one(query["auditCursor"])) === undefined ? {} : { cursor: decodeAuditCursor(one(query["auditCursor"])) }),
    });
    return {
      ids: page.entries.map((entry) => entry.id),
      goals: page.entries.map((entry) => (entry.after as { businessGoal: string | null }).businessGoal ?? ""),
      ...(page.nextCursor === undefined ? {} : { nextHref: auditHistoryHref(BASE, query, page.nextCursor) }),
    };
  };

  /** The query a link produces, which is the only way a page after the first is ever reached. */
  const queryFrom = (href: string): RawSearchParams => Object.fromEntries(new URLSearchParams(href.slice(href.indexOf("?") + 1)));

  it("reaches every change by following only the links it renders", async () => {
    const seen: string[] = [];
    const goals: string[] = [];
    let query: RawSearchParams = {};
    let pages = 0;

    for (;;) {
      const page = await screen(query);
      seen.push(...page.ids);
      goals.push(...page.goals);
      pages += 1;
      if (page.nextHref === undefined) {
        break;
      }
      query = queryFrom(page.nextHref);
      expect(pages, "the history did not terminate").toBeLessThan(10);
    }

    // Exactly once each: a cursor bug either repeats a row for ever or steps over one, and on a change
    // log both read as a change that did not happen the way it happened.
    expect(seen).toHaveLength(CHANGES);
    expect(new Set(seen).size).toBe(CHANGES);
    // And the twenty-first is genuinely among them, which is the entry the screen used to lose.
    expect(goals).toContain("ours change 00");
    expect(goals).toContain("ours change 24");
    expect(pages).toBeGreaterThan(1);
  }, 300_000);

  it("never shows another Workspace's changes, on the first page or a later one", async () => {
    const ours: string[] = [];
    let query: RawSearchParams = {};
    for (;;) {
      const page = await screen(query);
      ours.push(...page.goals);
      if (page.nextHref === undefined) {
        break;
      }
      query = queryFrom(page.nextHref);
    }

    // A cursor carries no authority: the read is scoped by the authorized context, so the worst a
    // borrowed one can do is point at a page of this profile's own history.
    expect(ours.filter((goal) => goal.startsWith("theirs"))).toEqual([]);

    const theirFirst = await screen({}, neighbour);
    const borrowed = theirFirst.nextHref;
    expect(borrowed).toBeDefined();
    const withTheirCursor = await screen(queryFrom(borrowed ?? ""), context);
    expect(withTheirCursor.goals.filter((goal) => goal.startsWith("theirs"))).toEqual([]);
  }, 300_000);

  it("shows both sides of each change, as the screen renders them", async () => {
    const page = await screen({});
    const entries = await listPolicyAudits(database.db, context, { limit: 2 });
    const [newest] = entries.entries;

    expect(page.ids[0]).toBe(newest?.id);
    // The diff the screen renders for the newest change: the goal moved, and nothing else did.
    expect(policyChangeDiff(newest?.before, newest?.after)).toEqual([
      { field: "businessGoal", before: "ours change 23", after: "ours change 24" },
    ]);
  }, 300_000);
});
