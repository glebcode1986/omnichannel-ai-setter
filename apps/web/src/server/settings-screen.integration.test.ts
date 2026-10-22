/**
 * The owner's AI-settings screen, from the profile creation path upwards, against a real database
 * (Issue #30).
 *
 * This file exists because of Astra's second R5 blocker on PR #79, and the blocker was not a bug inside
 * any one piece. `savePolicy` was correct, `readPolicies` was correct, the page rendered its form from the
 * stored policy, and the permanent policy suite passed — because that suite created the Business Profile
 * default itself. Nothing in production did. So a profile created the normal way had no policy, the page
 * found no `stored`, rendered no form, offered no first save, and automation stayed OFF with no way to
 * change it. Every piece was right and the feature was unusable, which is why the regression has to start
 * where a real owner starts: create the Workspace, create the profile, authorize somebody, and ask the
 * screen what it would render.
 *
 * Driven through the screen's own predicate rather than a restatement of it. `page.tsx` renders a form
 * exactly when `profileDefaultOf` finds a policy, so that is the function this asks.
 */
import {
  authorizeBusinessProfileAccess,
  authorizeWorkspaceAccess,
  createBusinessProfile,
  createWorkspaceWithOwner,
  readPolicies,
  savePolicy,
  WorkspacePermissionError,
  type BusinessProfileContext,
} from "@omnichannel/db";
import { DEFAULT_CONFIDENCE_THRESHOLD, DEFAULT_TAKEOVER_PAUSE_MS, MANDATORY_REVIEW_REASON_CODES } from "@omnichannel/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { mayEditSettings, profileDefaultOf } from "./settings-view";

describe.skipIf(!databaseTestsEnabled())("the AI settings screen for a normally created Business Profile", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
  }, 300_000);

  afterAll(async () => {
    await database?.dispose();
  });

  const db = () => database.db;

  /** A Workspace and a profile exactly as the product makes them, and nothing else. */
  const freshProfile = async (label: string): Promise<BusinessProfileContext> => {
    const owner = await db().user.create({ data: { name: `Owner ${label}`, email: `settings-screen-${label}@example.test` } });
    const { workspaceId } = await createWorkspaceWithOwner(db(), { name: `Workspace ${label}`, ownerUserId: owner.id });
    const workspace = await authorizeWorkspaceAccess(db(), { userId: owner.id, workspaceId });
    const profile = await createBusinessProfile(db(), workspace, { name: "Main" });
    return authorizeBusinessProfileAccess(db(), { userId: owner.id, workspaceId, businessProfileId: profile.businessProfileId });
  };

  it("has settings to render, and they are the conservative ones", async () => {
    const context = await freshProfile("fresh");

    const stored = profileDefaultOf(await readPolicies(db(), context));

    // The page's `form` is `undefined` when this is, so this expectation is the screen existing at all.
    expect(stored, "a normally created profile must have settings the screen can render").toBeDefined();
    expect(stored).toMatchObject({
      mode: "OFF",
      confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD,
      takeoverPauseMs: DEFAULT_TAKEOVER_PAUSE_MS,
      instagramAfterWindowPolicy: "STANDARD_ONLY",
      whatsappAfterWindowPolicy: "SERVICE_WINDOW_ONLY",
      whatsappTemplateAutomationAllowlist: [],
      version: 1,
    });
    // OFF and the full review floor: a profile nobody has configured yet sends nothing and holds
    // everything, which is the only starting state that cannot surprise its owner.
    expect([...(stored?.mandatoryReviewReasons ?? [])].sort()).toEqual([...MANDATORY_REVIEW_REASON_CODES].sort());
  }, 180_000);

  it("accepts the owner's first save against the version it rendered", async () => {
    const context = await freshProfile("first-save");
    const stored = profileDefaultOf(await readPolicies(db(), context));
    if (stored === undefined) {
      throw new Error("no settings to save against");
    }

    expect(mayEditSettings(context.role)).toBe(true);
    // Version 1 is what the form renders, so version 1 is what it posts back. This used to be `GONE`.
    const outcome = await savePolicy(db(), context, null, {
      expectedVersion: stored.version,
      mode: "DRAFT",
      businessGoal: "Book consultations",
    });

    expect(outcome.status).toBe("SAVED");
    expect(profileDefaultOf(await readPolicies(db(), context))).toMatchObject({ mode: "DRAFT", businessGoal: "Book consultations", version: 2 });
  }, 180_000);

  it("gives each profile its own settings, and never another profile's", async () => {
    const mine = await freshProfile("isolation-mine");
    const theirs = await freshProfile("isolation-theirs");

    const stored = profileDefaultOf(await readPolicies(db(), mine));
    await savePolicy(db(), mine, null, { expectedVersion: stored?.version ?? 1, mode: "AUTOPILOT" });

    // Two profiles, two policies: the one that was edited moved and the other did not.
    expect(profileDefaultOf(await readPolicies(db(), mine))).toMatchObject({ mode: "AUTOPILOT" });
    expect(profileDefaultOf(await readPolicies(db(), theirs))).toMatchObject({ mode: "OFF", version: 1 });
  }, 180_000);

  it("shows the settings to a member who may not change them, and still refuses their save", async () => {
    const owner = await freshProfile("agent-boundary");
    const agentUser = await db().user.create({ data: { name: "Agent", email: "settings-screen-agent@example.test" } });
    const member = await db().workspaceMember.create({
      data: { workspaceId: owner.workspaceId, userId: agentUser.id, role: "AGENT", businessProfileScope: "ALL" },
    });
    expect(member.role).toBe("AGENT");
    const agent = await authorizeBusinessProfileAccess(db(), {
      userId: agentUser.id,
      workspaceId: owner.workspaceId,
      businessProfileId: owner.businessProfileId,
    });

    const stored = profileDefaultOf(await readPolicies(db(), agent));

    // Read-only, which is the honest rendering of a form the store would refuse — and the boundary the
    // default existing must not have widened.
    expect(stored).toBeDefined();
    expect(mayEditSettings(agent.role)).toBe(false);
    await expect(savePolicy(db(), agent, null, { expectedVersion: stored?.version ?? 1, mode: "AUTOPILOT" })).rejects.toBeInstanceOf(
      WorkspacePermissionError,
    );
  }, 180_000);
});
