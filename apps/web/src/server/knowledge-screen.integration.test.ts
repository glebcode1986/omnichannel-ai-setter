/**
 * The Knowledge Library as the browser actually drives it, against a real database (Issue #31).
 *
 * `knowledge-view.test.ts` proves the URL codec in isolation and the store's own suite proves the query.
 * Neither proves the thing in between, and the thing in between is exactly what the blocking finding on
 * PR #77 was: the store paged at 25 and returned a cursor, the list could render a next link, and the
 * route read no cursor and passed no link — so a business with 26 sources could reach 25 of them, with
 * nothing on screen to say otherwise. Every piece was correct and the screen was broken.
 *
 * So this walks the loop the browser walks: build the query, read the page, follow the href the screen
 * produced, read the next one — and asserts the property a paging bug always violates, that every source
 * appears exactly once.
 *
 * `loadKnowledgeScreen` itself needs a request (authorization, locale), so the assembly under test here is
 * its filter and its cursor, called the same way it calls them.
 */
import {
  authorizeBusinessProfileAccess,
  authorizeWorkspaceAccess,
  createBusinessProfile,
  createKnowledge,
  archiveKnowledge,
  createWorkspaceWithOwner,
  editKnowledge,
  listKnowledge,
  publishKnowledge,
  readKnowledge,
  recordIndexingResult,
  type BusinessProfileContext,
} from "@omnichannel/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import type { RawSearchParams } from "./inbox-view";
import { decodeKnowledgeCursor, knowledgeFilterOf, knowledgeLifecycleOf, knowledgeNextHref, one } from "./knowledge-view";
import { expectedVersionOf } from "./knowledge-submission";

const BASE = "/workspaces/ws/profiles/bp/knowledge";

describe.skipIf(!databaseTestsEnabled())("the Knowledge Library screen's query", () => {
  let database: TestDatabase;
  let context: BusinessProfileContext;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    const db = database.db;
    const owner = await db.user.create({ data: { name: "Knowledge Screen Owner", email: "knowledge-screen@example.test" } });
    const { workspaceId } = await createWorkspaceWithOwner(db, { name: "Knowledge Screen Workspace", ownerUserId: owner.id });
    const workspace = await authorizeWorkspaceAccess(db, { userId: owner.id, workspaceId });
    const profile = await createBusinessProfile(db, workspace, { name: "Main" });
    context = await authorizeBusinessProfileAccess(db, { userId: owner.id, workspaceId, businessProfileId: profile.businessProfileId });

    // Twenty-six, because the page is twenty-five. The 26th is the one the screen used to lose.
    for (let index = 0; index < 26; index += 1) {
      const outcome = await createKnowledge(database.db, context, {
        title: `Source ${String(index).padStart(2, "0")}`,
        chunks: [`A fact belonging to source ${String(index)}.`],
        scope: "BUSINESS_PROFILE",
      });
      if (outcome.status !== "CREATED") {
        throw new Error(`the fixture expected CREATED, got ${outcome.status}`);
      }
    }
  }, 300_000);

  afterAll(async () => {
    await database?.dispose();
  });

  /** One request, as the screen handles it: a query in, a page and a next link out. */
  const screen = async (query: RawSearchParams): Promise<{ readonly titles: readonly string[]; readonly nextHref?: string }> => {
    const page = await listKnowledge(database.db, context, knowledgeFilterOf(query), {
      cursor: decodeKnowledgeCursor(one(query["cursor"])),
    });
    return {
      titles: page.documents.map((document) => document.title),
      ...(page.nextCursor === undefined ? {} : { nextHref: knowledgeNextHref(BASE, query, page.nextCursor) }),
    };
  };

  /** What the browser does with a link: take its query parameters into the next request. */
  const follow = (href: string): RawSearchParams => Object.fromEntries(new URL(href, "https://example.test").searchParams);

  it("reaches the twenty-sixth source by following the link it rendered", async () => {
    const first = await screen({});

    expect(first.titles).toHaveLength(25);
    expect(first.nextHref).toBeDefined();

    const second = await screen(follow(first.nextHref ?? ""));

    // The list is newest-updated first, so the one left over is the oldest source rather than the
    // highest-numbered. Naming it by exclusion keeps the case about reachability, not about the order.
    const missingFromFirstPage = Array.from({ length: 26 }, (_unused, index) => `Source ${String(index).padStart(2, "0")}`).filter(
      (title) => !first.titles.includes(title),
    );
    expect(missingFromFirstPage).toHaveLength(1);
    expect(second.titles).toEqual(missingFromFirstPage);
    expect(second.nextHref).toBeUndefined();
  }, 300_000);

  it("shows every source exactly once across the pages", async () => {
    const seen: string[] = [];
    let query: RawSearchParams = {};
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await screen(query);
      seen.push(...page.titles);
      if (page.nextHref === undefined) {
        break;
      }
      query = follow(page.nextHref);
    }

    // A cursor that overlapped would repeat a row; one that skipped would lose a source somebody typed.
    expect(seen).toHaveLength(26);
    expect(new Set(seen).size).toBe(26);
  }, 300_000);

  it("keeps the search while paging, instead of widening it on page two", async () => {
    // `Source 1` matches ten of them: 1, and 10 through 19. Enough to page with a limit of one filter.
    const first = await screen({ q: "Source 1" });

    expect(first.titles.every((title) => title.startsWith("Source 1"))).toBe(true);
    if (first.nextHref !== undefined) {
      const second = await screen(follow(first.nextHref));
      expect(second.titles.every((title) => title.startsWith("Source 1"))).toBe(true);
    }
    // And the link itself carries it, which is what makes the assertion above reachable in a browser.
    const href = knowledgeNextHref(BASE, { q: "Source 1" }, { updatedAt: new Date(), id: "kd_1" });
    expect(new URL(href, "https://example.test").searchParams.get("q")).toBe("Source 1");
  }, 300_000);

  /**
   * The detail screen's own loop: what the page would render, and what the button it rendered does.
   *
   * Astra's first finding was a gap between exactly these two. The store could publish a staged version
   * of a live source, the page showed the warning saying customers were still being answered with the old
   * one, and the only control it rendered for an ACTIVE document was Archive. Every piece worked and the
   * operator was stuck — so the test has to walk the whole way across: read what the page reads, take the
   * control the page would render, submit the field that control carries, and check what customers get.
   */
  describe("one source, through its lifecycle", () => {
    /** The page's own decision plus the hidden field its form submits, as the browser would post it. */
    const rendered = async (documentId: string) => {
      const detail = await readKnowledge(database.db, context, documentId);
      if (detail === undefined) {
        throw new Error("the fixture expected a readable document");
      }
      const form = new FormData();
      form.set("expectedVersion", String(detail.version));
      return { detail, lifecycle: knowledgeLifecycleOf(detail), form };
    };

    /**
     * The publish action's own path: the guard, then the store, with nothing in between.
     *
     * It carries *both* premises the control rendered — the version and the act — because that is what
     * the action does, and the act is the one a version check cannot stand in for: archiving leaves the
     * version alone.
     */
    const publishAsRendered = async (documentId: string, form: FormData, act: "PUBLISH" | "RESTORE" = "PUBLISH") => {
      const expectedVersion = expectedVersionOf(form);
      if (expectedVersion === undefined) {
        throw new Error("the control the page rendered carried no version");
      }
      return publishKnowledge(database.db, context, documentId, { expectedVersion, act });
    };

    const staged = async (title: string) => {
      const created = await createKnowledge(database.db, context, { title, chunks: ["The wording that was published."], scope: "BUSINESS_PROFILE" });
      if (created.status !== "CREATED") {
        throw new Error(`the fixture expected CREATED, got ${created.status}`);
      }
      const id = created.documentId;
      await recordIndexingResult(database.db, context, id, { ok: true, at: new Date("2026-10-04T12:00:00.000Z"), version: 1 });
      await publishKnowledge(database.db, context, id, { expectedVersion: 1 });
      await editKnowledge(database.db, context, id, { chunks: ["The wording somebody has since saved."], expectedVersion: 1 });
      return id;
    };

    it("offers a publish for an edited live source, and publishing it changes what customers are told", async () => {
      const id = await staged("Edited live source");

      const before = await rendered(id);
      expect(before.detail).toMatchObject({ status: "ACTIVE", version: 2, publishedVersion: 1 });
      // The finding, as one assertion: the page used to decide "ACTIVE, so Archive" here.
      expect(before.lifecycle).toBe("publish");

      expect(await publishAsRendered(id, before.form)).toEqual({ status: "RESTORED", version: 2 });

      const after = await rendered(id);
      expect(after.detail).toMatchObject({ status: "ACTIVE", version: 2, publishedVersion: 2 });
      // And the control is gone, because there is nothing left to publish.
      expect(after.lifecycle).toBeUndefined();
    }, 300_000);

    it("refuses the publish when the page the operator clicked on was out of date", async () => {
      const id = await staged("Stale detail screen");

      // Tab B renders at v2. Tab A then saves v3.
      const tabB = await rendered(id);
      await editKnowledge(database.db, context, id, { chunks: ["The wording tab A saved afterwards."], expectedVersion: 2 });

      expect(await publishAsRendered(id, tabB.form)).toEqual({ status: "CONFLICT", expectedVersion: 2, currentVersion: 3 });
      // Nothing moved: v1 is still what customers are answered with, which is what the refusal says.
      expect(await readKnowledge(database.db, context, id)).toMatchObject({ version: 3, publishedVersion: 1 });
    }, 300_000);

    it("refuses the Publish a stale tab rendered before somebody archived the source", async () => {
      // Astra's finding on the repaired head, through the screen's own path. Archiving deliberately
      // leaves the version alone, so the expected version the page rendered still matches — and the click
      // used to write ACTIVE over the archive and report success, putting a withdrawn source back in
      // front of customers with nothing on screen to say why.
      const id = await staged("Archived under a stale tab");

      // Tab B renders Publish for the staged version. Tab A archives the source.
      const tabB = await rendered(id);
      expect(tabB.lifecycle).toBe("publish");
      await archiveKnowledge(database.db, context, id);

      expect(await publishAsRendered(id, tabB.form)).toMatchObject({ status: "STALE_STATE", current: "ARCHIVED" });
      expect(await readKnowledge(database.db, context, id)).toMatchObject({ status: "ARCHIVED", publishedVersion: 1 });
      // And the page an operator reloads now offers to use it again, which is a different decision.
      expect((await rendered(id)).lifecycle).toBe("restore");
    }, 300_000);

    it("offers nothing to publish on a live source nobody has edited", async () => {
      const created = await createKnowledge(database.db, context, { title: "Untouched live source", chunks: ["A published fact."] });
      if (created.status !== "CREATED") {
        throw new Error(`the fixture expected CREATED, got ${created.status}`);
      }
      await publishKnowledge(database.db, context, created.documentId, { expectedVersion: 1 });

      expect((await rendered(created.documentId)).lifecycle).toBeUndefined();
    }, 300_000);
  });

  it("ignores a filter value the store does not know, rather than passing it through", async () => {
    const page = await screen({ status: "NOT_A_STATUS", indexing: "", scope: "WORKSPACE" });

    // WORKSPACE is a real scope and none of these sources are workspace-wide, so the honest answer is an
    // empty page — not every row because the filter was dropped, and not an error because a URL was odd.
    expect(page.titles).toEqual([]);
    expect(knowledgeFilterOf({ status: "NOT_A_STATUS" })).toEqual({});
  }, 300_000);
});
