/**
 * Style Training as the browser actually drives it, against a real database (Issue #32).
 *
 * Both lists on this page paged at 25 in the store and neither paged on screen: the route called
 * `listStyleExamples` twice with no cursor and no component offered a link. The first 25 of each were
 * correct, so nothing failed. A suggestion nobody can reach is one nobody can approve or reject, and it
 * stays SUGGESTED.
 *
 * The property this file exists for is the one that makes this page different from the Inbox, the
 * Knowledge Library and the Review queue: **two lists, paging independently.** A single shared `cursor`
 * would make "show more suggestions" also advance the verified library, and an operator would lose their
 * place in one list by moving through the other — a bug that looks like data disappearing.
 */
import {
  archiveStyleExample,
  authorizeBusinessProfileAccess,
  authorizeWorkspaceAccess,
  createBusinessProfile,
  createStyleExample,
  createWorkspaceWithOwner,
  listStyleExamples,
  rejectStyleExample,
  suggestStyleExample,
  type BusinessProfileContext,
} from "@omnichannel/db";
import { PLATFORM_STYLE_FALLBACK } from "@omnichannel/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import type { RawSearchParams } from "./inbox-view";
import { assembleStyleScreen } from "./style-screen";
import { encodeStyleCursor } from "./style-view";
import type { StyleTestResult } from "./style-test";

const BASE = "/workspaces/ws/profiles/bp/style";

describe.skipIf(!databaseTestsEnabled())("the Style Training screen's queries", () => {
  let database: TestDatabase;
  let context: BusinessProfileContext;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    const db = database.db;
    const owner = await db.user.create({ data: { name: "Style Screen Owner", email: "style-screen@example.test" } });
    const { workspaceId } = await createWorkspaceWithOwner(db, { name: "Style Screen Workspace", ownerUserId: owner.id });
    const workspace = await authorizeWorkspaceAccess(db, { userId: owner.id, workspaceId });
    const profile = await createBusinessProfile(db, workspace, { name: "Main" });
    context = await authorizeBusinessProfileAccess(db, { userId: owner.id, workspaceId, businessProfileId: profile.businessProfileId });

    // Twenty-six of each, because each page is twenty-five.
    for (let index = 0; index < 26; index += 1) {
      const verified = await createStyleExample(database.db, context, {
        inboundContext: `Verified question ${String(index).padStart(2, "0")}?`,
        outboundText: `Verified reply ${String(index).padStart(2, "0")}`,
      });
      if (verified.status !== "SAVED") {
        throw new Error(`the fixture expected SAVED, got ${verified.status}`);
      }
      const suggested = await suggestStyleExample(database.db, context, {
        inboundContext: `Suggested question ${String(index).padStart(2, "0")}?`,
        outboundText: `Suggested reply ${String(index).padStart(2, "0")}`,
      });
      if (suggested.status !== "SAVED") {
        throw new Error(`the fixture expected SAVED, got ${suggested.status}`);
      }
    }
  }, 300_000);

  afterAll(async () => {
    await database?.dispose();
  });

  /**
   * The style test, stood in for.
   *
   * This file is about which rows the screen shows. Running the real test here would make every assertion
   * about paging depend on a provider key and an embedding key, and would prove nothing extra: what the
   * test produces is covered by `style-test.test.ts` and `style-test-panel.test.tsx`.
   */
  const NO_TEST: StyleTestResult = {
    effective: { ...PLATFORM_STYLE_FALLBACK },
    trial: { mode: "LEXICAL_ONLY", hits: [], unavailable: false },
    candidate: { status: "NO_PROMPT" },
  };

  /**
   * One request, as the screen handles it.
   *
   * The screen's *own* assembly, not a copy of it. A helper that reissued the queries by hand would pass
   * against a loader that had stopped reading one of the lists — which is exactly the bug this screen
   * shipped with twice.
   */
  const screen = async (query: RawSearchParams) => {
    const data = await assembleStyleScreen(database.db, context, query, BASE, NO_TEST);
    return {
      verified: data.verified.examples.map((example) => example.outboundText),
      suggestions: data.suggestions.examples.map((example) => example.outboundText),
      retired: data.retired.examples.map((example) => example.outboundText),
      verifiedNextHref: data.verifiedNextHref,
      suggestionsNextHref: data.suggestionsNextHref,
      retiredNextHref: data.retiredNextHref,
    };
  };

  /** The id of a row the screen would show, found through the same store the screen reads it with. */
  const idOf = async (status: "ACTIVE" | "SUGGESTED" | "ARCHIVED" | "REJECTED", outboundText: string) => {
    const page = await listStyleExamples(database.db, context, { status }, { limit: 100 });
    const row = page.examples.find((example) => example.outboundText === outboundText);
    if (row === undefined) {
      throw new Error(`the fixture expected a ${status} example reading "${outboundText}"`);
    }
    return row.id;
  };

  /** What the browser does with a link: take its query parameters into the next request. */
  const follow = (href: string): RawSearchParams => Object.fromEntries(new URL(href, "https://example.test").searchParams);

  it("reaches the twenty-sixth verified example, and the twenty-sixth suggestion", async () => {
    const first = await screen({});

    expect(first.verified).toHaveLength(25);
    expect(first.suggestions).toHaveLength(25);

    const nextVerified = await screen(follow(first.verifiedNextHref ?? ""));
    const nextSuggested = await screen(follow(first.suggestionsNextHref ?? ""));

    expect(nextVerified.verified).toHaveLength(1);
    expect(nextSuggested.suggestions).toHaveLength(1);
    expect(first.verified).not.toContain(nextVerified.verified[0]);
    expect(first.suggestions).not.toContain(nextSuggested.suggestions[0]);
  }, 300_000);

  it("pages one list without moving the other", async () => {
    // The property a shared cursor would break, and the reason each list has a parameter of its own.
    const first = await screen({});

    const advanced = await screen(follow(first.suggestionsNextHref ?? ""));

    expect(advanced.suggestions).not.toEqual(first.suggestions);
    expect(advanced.verified).toEqual(first.verified);
  }, 300_000);

  it("shows every example exactly once across each list's pages", async () => {
    for (const list of ["verified", "suggested"] as const) {
      const seen: string[] = [];
      let query: RawSearchParams = {};
      for (let guard = 0; guard < 10; guard += 1) {
        const page = await screen(query);
        seen.push(...(list === "verified" ? page.verified : page.suggestions));
        const next = list === "verified" ? page.verifiedNextHref : page.suggestionsNextHref;
        if (next === undefined) {
          break;
        }
        query = follow(next);
      }

      expect(seen).toHaveLength(26);
      expect(new Set(seen).size).toBe(26);
    }
  }, 300_000);

  it("carries the retrieval question through a page change", async () => {
    // The tester's question lives in the same URL. Paging a list used to be the only way to move through
    // this page, and dropping `ask` would clear the trial an operator was reading.
    const first = await screen({ ask: "do you do gift cards?" });

    const next = follow(first.suggestionsNextHref ?? "");

    expect(next["ask"]).toBe("do you do gift cards?");
    expect(next["suggestedCursor"]).toBeDefined();
    expect(next["verifiedCursor"]).toBeUndefined();
  }, 300_000);

  it("shows page one for a cursor nobody wrote, rather than an error", async () => {
    const page = await screen({ suggestedCursor: "not-a-cursor", verifiedCursor: "" });

    expect(page.verified).toHaveLength(25);
    expect(page.suggestions).toHaveLength(25);
  }, 300_000);

  /**
   * The acceptance path the screen used to break (R5 finding).
   *
   * The store could archive, reject and restore; the component could draw a restore button; and the loader
   * read only ACTIVE and SUGGESTED rows. So the moment somebody withdrew an example or declined a
   * suggestion it left both lists, nothing passed it to the component that knows how to bring it back, and
   * no user could reach the restore control at all. Nothing failed — a capability simply did not exist.
   */
  it("still shows an example after it is withdrawn, so it can be brought back", async () => {
    const live = await createStyleExample(database.db, context, {
      inboundContext: "do you take walk-ins?",
      outboundText: "Walk-ins welcome before noon.",
    });
    if (live.status !== "SAVED") {
      throw new Error(`the fixture expected SAVED, got ${live.status}`);
    }
    const id = await idOf("ACTIVE", "Walk-ins welcome before noon.");

    expect(await archiveStyleExample(database.db, context, id)).toEqual({ status: "ARCHIVED" });
    const after = await screen({});

    expect(after.verified).not.toContain("Walk-ins welcome before noon.");
    expect(after.retired).toContain("Walk-ins welcome before noon.");
  }, 300_000);

  it("shows a declined suggestion in the same place, because it is the same question", async () => {
    const suggestion = await suggestStyleExample(database.db, context, {
      inboundContext: "any chance of a late slot?",
      outboundText: "Late slots on Thursdays only.",
    });
    if (suggestion.status !== "SAVED") {
      throw new Error(`the fixture expected SAVED, got ${suggestion.status}`);
    }
    const id = await idOf("SUGGESTED", "Late slots on Thursdays only.");

    expect(await rejectStyleExample(database.db, context, id)).toEqual({ status: "REJECTED_EXAMPLE" });
    const after = await screen({});

    // Withdrawn and declined are one list on screen: to the person looking, both are an example that is
    // not in use and could be.
    expect(after.suggestions).not.toContain("Late slots on Thursdays only.");
    expect(after.retired).toContain("Late slots on Thursdays only.");
  }, 300_000);

  it("pages the retired list on a cursor of its own", async () => {
    // Two retired rows is enough to show the property: advancing past the first must move *this* list and
    // leave the other two exactly where they were. A single shared cursor would have advanced all three,
    // which reads to an operator as the other lists losing rows.
    for (const wording of ["Closed on bank holidays.", "We can text you a reminder."]) {
      const created = await createStyleExample(database.db, context, { inboundContext: `about ${wording}`, outboundText: wording });
      if (created.status !== "SAVED") {
        throw new Error(`the fixture expected SAVED, got ${created.status}`);
      }
      await archiveStyleExample(database.db, context, await idOf("ACTIVE", wording));
    }
    const first = await screen({});
    const retiredPage = await listStyleExamples(database.db, context, { status: "ARCHIVED" }, { limit: 1 });
    if (retiredPage.nextCursor === undefined) {
      throw new Error("the fixture expected more than one retired example");
    }

    const advanced = await screen({ retiredCursor: encodeStyleCursor(retiredPage.nextCursor) });

    expect(advanced.retired).not.toEqual(first.retired);
    expect(advanced.verified).toEqual(first.verified);
    expect(advanced.suggestions).toEqual(first.suggestions);
  }, 300_000);
});
