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
  authorizeBusinessProfileAccess,
  authorizeWorkspaceAccess,
  createBusinessProfile,
  createStyleExample,
  createWorkspaceWithOwner,
  listStyleExamples,
  suggestStyleExample,
  type BusinessProfileContext,
} from "@omnichannel/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import type { RawSearchParams } from "./inbox-view";
import { styleCursorOf, styleNextHref, type StyleList } from "./style-view";

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

  /** One request, as the screen handles it: a query in, two pages and up to two links out. */
  const screen = async (query: RawSearchParams) => {
    const [verified, suggestions] = await Promise.all([
      listStyleExamples(database.db, context, { status: "ACTIVE" }, { cursor: styleCursorOf(query, "verified") }),
      listStyleExamples(database.db, context, { status: "SUGGESTED" }, { cursor: styleCursorOf(query, "suggested") }),
    ]);
    const href = (list: StyleList, cursor: Parameters<typeof styleNextHref>[3] | undefined) =>
      cursor === undefined ? undefined : styleNextHref(BASE, query, list, cursor);
    return {
      verified: verified.examples.map((example) => example.outboundText),
      suggestions: suggestions.examples.map((example) => example.outboundText),
      verifiedNextHref: href("verified", verified.nextCursor),
      suggestionsNextHref: href("suggested", suggestions.nextCursor),
    };
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
});
