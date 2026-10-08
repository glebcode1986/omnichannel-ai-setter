/**
 * The Style Training URL, in both directions (Issue #32, R5 re-review).
 *
 * These four functions are the whole contract between a link somebody clicks and a store read, and until
 * this file every assertion about them lived inside a database-gated suite — so the clean-environment
 * `pnpm verify` that CI runs first exercised none of them. A cursor codec is exactly the kind of code that
 * should be tested without a database: it is pure, and its failure mode is a page that silently shows the
 * wrong rows rather than an error anybody sees.
 */
import { describe, expect, it } from "vitest";

import {
  decodeDecisionCursor,
  decodeStyleCursor,
  encodeDecisionCursor,
  encodeStyleCursor,
  styleCursorOf,
  styleHistoryHref,
  styleHistoryRequest,
  styleNextHref,
} from "./style-view";

const BASE = "/workspaces/ws_1/profiles/bp_1/style";
const AT = new Date("2026-10-01T09:30:00.000Z");

describe("the decision cursor", () => {
  it("survives a round trip, both halves of it", () => {
    // Both halves travel because `decidedAt` is not unique. A codec that dropped the id would page from
    // an instant with no tiebreak, which repeats or skips rows.
    const encoded = encodeDecisionCursor({ decidedAt: AT, id: "sed_7" });

    expect(decodeDecisionCursor(encoded)).toEqual({ decidedAt: AT, id: "sed_7" });
  });

  it("is opaque rather than secret, so a link survives a bookmark", () => {
    const encoded = encodeDecisionCursor({ decidedAt: AT, id: "sed_7" });

    expect(encoded).not.toContain("sed_7");
    expect(Buffer.from(encoded, "base64url").toString("utf8")).toBe("2026-10-01T09:30:00.000Z|sed_7");
  });

  it("rejects anything this module did not write, rather than guessing", () => {
    // A cursor carries no authority — the store scopes every read to the profile in the route — so the
    // worst a forged one can do is point at a page. The honest answer to an unreadable one is "no cursor",
    // which is the first page, and not a `NaN` date smuggled into a query.
    expect(decodeDecisionCursor(undefined)).toBeUndefined();
    expect(decodeDecisionCursor("")).toBeUndefined();
    expect(decodeDecisionCursor("not base64url at all")).toBeUndefined();
    expect(decodeDecisionCursor(Buffer.from("no separator", "utf8").toString("base64url"))).toBeUndefined();
    expect(decodeDecisionCursor(Buffer.from("not-a-date|sed_7", "utf8").toString("base64url"))).toBeUndefined();
    expect(decodeDecisionCursor(Buffer.from(`${AT.toISOString()}|`, "utf8").toString("base64url"))).toBeUndefined();
  });

  it("is a different codec from the example cursor, so one cannot be read as the other", () => {
    // They are both `(instant, id)` tuples and both base64url, which is exactly why this is worth
    // pinning: the two parameters are never interchangeable even when the encodings look alike.
    const asExample = encodeStyleCursor({ createdAt: AT, id: "se_3" });

    expect(decodeDecisionCursor(asExample)).toEqual({ decidedAt: AT, id: "se_3" });
    expect(decodeStyleCursor(encodeDecisionCursor({ decidedAt: AT, id: "sed_3" }))).toEqual({ createdAt: AT, id: "sed_3" });
  });
});

describe("which history a request has open", () => {
  it("names the example and the point in it", () => {
    const request = styleHistoryRequest({ historyExample: "se_1", historyCursor: encodeDecisionCursor({ decidedAt: AT, id: "sed_7" }) });

    expect(request).toEqual({ styleExampleId: "se_1", before: { decidedAt: AT, id: "sed_7" } });
  });

  it("drops a cursor with no example, rather than applying it to whichever example came first", () => {
    const request = styleHistoryRequest({ historyCursor: encodeDecisionCursor({ decidedAt: AT, id: "sed_7" }) });

    expect(request).toEqual({});
  });

  it("opens the newest page for an example with no cursor", () => {
    expect(styleHistoryRequest({ historyExample: "se_1" })).toEqual({ styleExampleId: "se_1" });
  });

  it("reads nothing out of an empty request", () => {
    expect(styleHistoryRequest({})).toEqual({});
    expect(styleHistoryRequest({ historyExample: "", historyCursor: "" })).toEqual({});
  });
});

describe("the link into a history", () => {
  it("carries the lists' own cursors through, so opening a history does not reset the page under it", () => {
    const href = styleHistoryHref(BASE, { retiredCursor: "abc", ask: "are you open?" }, "se_1", { decidedAt: AT, id: "sed_7" });
    const params = new URL(href, "https://example.test").searchParams;

    expect(params.get("retiredCursor")).toBe("abc");
    expect(params.get("ask")).toBe("are you open?");
    expect(params.get("historyExample")).toBe("se_1");
    expect(decodeDecisionCursor(params.get("historyCursor") ?? undefined)).toEqual({ decidedAt: AT, id: "sed_7" });
  });

  it("drops `outcome`, because a write that already happened must not be announced twice", () => {
    const href = styleHistoryHref(BASE, { outcome: "SAVED" }, "se_1", undefined);

    expect(new URL(href, "https://example.test").searchParams.get("outcome")).toBeNull();
  });

  it("is the way back to the newest events when it names neither", () => {
    // The escape hatch. With no example and no cursor it is the same screen with the history closed.
    expect(styleHistoryHref(BASE, { historyExample: "se_1", historyCursor: "abc" }, undefined, undefined)).toBe(BASE);
  });

  it("replaces an open history rather than appending to it", () => {
    const href = styleHistoryHref(BASE, { historyExample: "se_1", historyCursor: "old" }, "se_2", { decidedAt: AT, id: "sed_9" });
    const params = new URL(href, "https://example.test").searchParams;

    expect(params.getAll("historyExample")).toEqual(["se_2"]);
    expect(params.get("historyCursor")).not.toBe("old");
  });
});

describe("paging a list while a history is open", () => {
  it("closes the history, because the example is probably not on the next page", () => {
    // Carrying the parameters forward produced a URL that loaded a lifecycle no list rendered — and the
    // link back to the newest events lives on the example's own row, so it went with it. The Inbox drops
    // its cursor when a filter changes for the same reason: a new set of rows is a new view.
    const href = styleNextHref(BASE, { historyExample: "se_1", historyCursor: "abc", ask: "kept" }, "retired", { createdAt: AT, id: "se_9" });
    const params = new URL(href, "https://example.test").searchParams;

    expect(params.get("historyExample")).toBeNull();
    expect(params.get("historyCursor")).toBeNull();
    // Everything else is carried through untouched, which is what the other list's cursor depends on.
    expect(params.get("ask")).toBe("kept");
    expect(styleCursorOf(Object.fromEntries(params), "retired")).toEqual({ createdAt: AT, id: "se_9" });
  });
});
