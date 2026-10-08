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
  restoreStyleExample,
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

  it("reaches every event of a long lifecycle through the links it renders", async () => {
    // The R5 re-review's blocking finding, driven through the screen rather than the store: the window
    // used to hold the twenty *oldest* decisions, so from the twenty-first onwards the events that
    // explained an example's current state were gone, with no cursor, no count and no link.
    // Its own row, not one of the twenty-six seeded ACTIVE examples. Archiving one of those would drop
    // that list to twenty-five and quietly break the paging assertions above — which pass today only
    // because Vitest runs these in declaration order.
    const created = await createStyleExample(database.db, context, {
      inboundContext: "how long is this argument?",
      outboundText: "A long argument indeed.",
    });
    if (created.status !== "SAVED") {
      throw new Error(`the fixture expected SAVED, got ${created.status}`);
    }
    const id = await idOf("ACTIVE", "A long argument indeed.");
    await archiveStyleExample(database.db, context, id);
    const expected: string[] = ["ARCHIVED"];
    for (let round = 0; round < 12; round += 1) {
      await restoreStyleExample(database.db, context, id);
      await archiveStyleExample(database.db, context, id);
      expected.push("RESTORED", "ARCHIVED");
    }
    expect(expected).toHaveLength(25);

    let query: RawSearchParams = {};
    const collected: string[] = [];
    let pages = 0;
    for (;;) {
      const data = await assembleStyleScreen(database.db, context, query, BASE, NO_TEST);
      const shown =
        data.lifecycle?.styleExampleId === id
          ? data.lifecycle
          : data.retired.examples.find((example) => example.id === id);
      expect(shown, "the example must be on the screen that offers its history").toBeDefined();
      collected.unshift(...(shown?.decisions.map((entry) => entry.decision) ?? []));
      const href = data.earlierHistoryHrefs[id];
      if (href === undefined) {
        expect(shown?.earlierDecisions, "no link must mean nothing earlier").toBe(0);
        break;
      }
      // Every page the screen offers is reachable with nothing but the link it rendered.
      query = follow(href);
      pages += 1;
      expect(pages, "paging must terminate").toBeLessThan(8);
    }

    expect(collected).toEqual(expected);
    // The first screen held the most recent twenty and said how many it had left behind.
    const first = await assembleStyleScreen(database.db, context, {}, BASE, NO_TEST);
    const preview = first.retired.examples.find((example) => example.id === id);
    expect(preview?.decisions).toHaveLength(20);
    expect(preview?.earlierDecisions).toBe(5);
    expect(preview?.decisions.at(-1)?.decision).toBe("ARCHIVED");
  }, 300_000);

  it("offers the way back to the most recent events, and leaves the other lists where they were", async () => {
    const id = await idOf("ARCHIVED", "A long argument indeed.");
    const opened = await assembleStyleScreen(database.db, context, follow(
      (await assembleStyleScreen(database.db, context, {}, BASE, NO_TEST)).earlierHistoryHrefs[id] ?? "",
    ), BASE, NO_TEST);

    expect(opened.lifecycle?.styleExampleId).toBe(id);
    expect(opened.latestHistoryHref).toBeDefined();
    // Following it drops the history and nothing else, which is why the history has parameters of its own.
    const back = await assembleStyleScreen(database.db, context, follow(opened.latestHistoryHref ?? ""), BASE, NO_TEST);
    expect(back.lifecycle).toBeUndefined();
    expect(back.retired.examples.map((example) => example.outboundText)).toEqual(
      (await assembleStyleScreen(database.db, context, {}, BASE, NO_TEST)).retired.examples.map((example) => example.outboundText),
    );
  }, 300_000);

  it("says how many later events a page into the past is hiding", async () => {
    // The half a backwards page necessarily hides, and the one that explains the current state. Without
    // it the screen would show a history ending in RESTORED under a status reading ARCHIVED.
    const id = await idOf("ARCHIVED", "A long argument indeed.");
    const first = await assembleStyleScreen(database.db, context, {}, BASE, NO_TEST);
    const opened = await assembleStyleScreen(database.db, context, follow(first.earlierHistoryHrefs[id] ?? ""), BASE, NO_TEST);

    expect(opened.lifecycle?.laterDecisions).toBe(20);
    expect(opened.lifecycle?.totalDecisions).toBe(25);
    // And the newest window hides nothing later, which is what makes the common case silent.
    expect(first.retired.examples.find((example) => example.id === id)?.laterDecisions).toBe(0);
  }, 300_000);

  it("closes an open history when a list pages, rather than loading one nothing renders", async () => {
    // The state this prevents: the history parameters ride along on a list's "show more" link, the
    // example leaves the screen, and the page loads a lifecycle no component renders — taking the link
    // back to the newest events with it, because that link lives on the example's own row.
    const id = await idOf("ARCHIVED", "A long argument indeed.");
    const first = await assembleStyleScreen(database.db, context, { historyExample: id }, BASE, NO_TEST);
    expect(first.lifecycle?.styleExampleId).toBe(id);

    const paged = follow(first.suggestionsNextHref ?? "");
    expect(paged["historyExample"], "paging a list must not carry an open history forward").toBeUndefined();

    // And if a hand-written URL does carry one for an example that is not on screen, the screen declines
    // to open it rather than loading a history it cannot show.
    const offScreen = await assembleStyleScreen(database.db, context, { ...paged, historyExample: id, suggestedCursor: paged["suggestedCursor"] ?? "" }, BASE, NO_TEST);
    const onScreen = [...offScreen.verified.examples, ...offScreen.suggestions.examples, ...offScreen.retired.examples].map((example) => example.id);
    if (!onScreen.includes(id)) {
      expect(offScreen.lifecycle).toBeUndefined();
      expect(offScreen.latestHistoryHref).toBeUndefined();
    }
  }, 300_000);

  it("reaches the twenty-sixth declined suggestion, and every retired row exactly once", async () => {
    // The blocking finding Astra returned on `66a317f`. The retired list was two queries concatenated —
    // `ARCHIVED` consumed the `retired` cursor while `REJECTED` was always its own first twenty-five — so
    // one cursor could not continue both and the twenty-sixth declined suggestion was unreachable by any
    // rendered link. Its lifecycle went with it, because a history only opens for an example on the page.
    //
    // Twenty-eight rejected and three archived, so both halves exceed nothing on their own and the merge
    // is what used to break. Everything is created here rather than taken from the seeded fixtures, so
    // the assertions are about this test's own rows.
    const mine: string[] = [];
    for (let index = 0; index < 28; index += 1) {
      const outboundText = `Declined reply ${String(index).padStart(2, "0")}`;
      const created = await suggestStyleExample(database.db, context, { inboundContext: `Declined question ${index}?`, outboundText });
      if (created.status !== "SAVED") {
        throw new Error(`the fixture expected SAVED, got ${created.status}`);
      }
      const id = await idOf("SUGGESTED", outboundText);
      expect(await rejectStyleExample(database.db, context, id)).toEqual({ status: "REJECTED_EXAMPLE" });
      mine.push(id);
    }
    for (let index = 0; index < 3; index += 1) {
      const outboundText = `Withdrawn reply ${String(index).padStart(2, "0")}`;
      const created = await createStyleExample(database.db, context, { inboundContext: `Withdrawn question ${index}?`, outboundText });
      if (created.status !== "SAVED") {
        throw new Error(`the fixture expected SAVED, got ${created.status}`);
      }
      const id = await idOf("ACTIVE", outboundText);
      expect(await archiveStyleExample(database.db, context, id)).toEqual({ status: "ARCHIVED" });
      mine.push(id);
    }

    // Walk the retired list using nothing but the link the screen renders.
    const seen: string[] = [];
    let query: RawSearchParams = {};
    let pages = 0;
    for (;;) {
      const data = await assembleStyleScreen(database.db, context, query, BASE, NO_TEST);
      seen.push(...data.retired.examples.map((example) => example.id));
      if (data.retiredNextHref === undefined) {
        break;
      }
      query = follow(data.retiredNextHref);
      pages += 1;
      expect(pages, "paging must terminate").toBeLessThan(20);
    }

    // Every row this test created, reached, and reached once. Both halves of the finding: nothing skipped
    // and nothing duplicated across a boundary that used to be a concatenation.
    expect(new Set(seen).size).toBe(seen.length);
    expect(mine.filter((id) => !seen.includes(id)), "every retired example must be reachable").toEqual([]);
    // And the rejected rows are genuinely spread past the first page rather than all landing on it, or
    // the walk above would prove nothing about continuation.
    expect(pages).toBeGreaterThan(0);

    // Stable ordering, newest first across both statuses — one keyset rather than two lists joined.
    const firstPage = await assembleStyleScreen(database.db, context, {}, BASE, NO_TEST);
    const times = firstPage.retired.examples.map((example) => example.createdAt.getTime());
    expect(times).toEqual([...times].toSorted((left, right) => right - left));
    expect(new Set(firstPage.retired.examples.map((example) => example.status))).toEqual(new Set(["ARCHIVED", "REJECTED"]));
  }, 600_000);

  it("opens the lifecycle of a retired example that only a later page reaches", async () => {
    // The second half of the finding: knowing an id was not enough, because a history opens only for an
    // example already on the page. So the row has to be reachable *and* its history has to open there.
    const target = await idOf("REJECTED", "Declined reply 00");

    let query: RawSearchParams = {};
    let found: Awaited<ReturnType<typeof assembleStyleScreen>> | undefined;
    for (let page = 0; page < 20; page += 1) {
      const data = await assembleStyleScreen(database.db, context, query, BASE, NO_TEST);
      if (data.retired.examples.some((example) => example.id === target)) {
        found = data;
        break;
      }
      if (data.retiredNextHref === undefined) {
        break;
      }
      query = follow(data.retiredNextHref);
    }
    expect(found, "the example must be reachable by following rendered links").toBeDefined();

    // Its history opens on the page that reached it, with the list's own cursor carried through.
    const opened = await assembleStyleScreen(database.db, context, { ...query, historyExample: target }, BASE, NO_TEST);
    expect(opened.lifecycle?.styleExampleId).toBe(target);
    expect(opened.lifecycle?.decisions.map((entry) => entry.decision)).toEqual(["REJECTED"]);
    expect(opened.latestHistoryHref).toBeDefined();
  }, 600_000);

  it("opens no history for an example this profile cannot see, or for one nobody wrote", async () => {
    // A cursor and an example id carry no authority: the store scopes every read to the profile in the
    // route, so a forged parameter is a forged parameter rather than a read of another tenant's history.
    const forged = await assembleStyleScreen(database.db, context, { historyExample: "se_not_here" }, BASE, NO_TEST);

    expect(forged.lifecycle).toBeUndefined();
    expect(forged.latestHistoryHref).toBeUndefined();
    // And the rest of the screen is unaffected: a bad parameter must not empty the page.
    expect(forged.verified.examples.length).toBeGreaterThan(0);
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
