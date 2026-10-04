/**
 * The Knowledge Library's URL, which is what made page two reachable (Issue #31).
 *
 * The blocking finding on PR #77 was that the library stopped at 25 rows: the store returned a cursor and
 * the route never read one, so everything after the first page was absent with nothing on screen to say
 * so. These cases are about the two halves of fixing that — a cursor that survives a URL, and a next link
 * that still carries the filters the person is looking at.
 */
import { describe, expect, it } from "vitest";

import { decodeKnowledgeCursor, encodeKnowledgeCursor, knowledgeNextHref } from "./knowledge-view";

const BASE = "/workspaces/ws_1/profiles/bp_1/knowledge";
const CURSOR = { updatedAt: new Date("2026-09-30T11:00:00.000Z"), id: "kd_25" };

describe("the cursor in the URL", () => {
  it("survives a round trip", () => {
    expect(decodeKnowledgeCursor(encodeKnowledgeCursor(CURSOR))).toEqual(CURSOR);
  });

  it("is URL-safe, so a bookmark and a chat client cannot corrupt it", () => {
    // base64url: no `+`, no `/`, no `=` padding to be stripped by something well-meaning.
    expect(encodeKnowledgeCursor(CURSOR)).toMatch(/^[A-Za-z0-9_-]+$/u);
  });

  it("refuses anything this module did not write, rather than paging from nonsense", () => {
    for (const nonsense of [undefined, "", "not-a-cursor", Buffer.from("no-separator", "utf8").toString("base64url"), Buffer.from("not-a-date|kd_1", "utf8").toString("base64url"), Buffer.from("2026-09-30T11:00:00.000Z|", "utf8").toString("base64url")]) {
      expect(decodeKnowledgeCursor(nonsense)).toBeUndefined();
    }
  });
});

describe("the next link", () => {
  it("keeps every filter the person is looking at", () => {
    // The failure this prevents is quiet: a "load more" that drops the search pages through the whole
    // library instead of the four rows that matched, and looks like it worked.
    const href = knowledgeNextHref(BASE, { status: "ACTIVE", indexing: "INDEXED", scope: "WORKSPACE", q: "refund policy" }, CURSOR);

    const url = new URL(href, "https://example.test");
    expect(url.pathname).toBe(BASE);
    expect(url.searchParams.get("status")).toBe("ACTIVE");
    expect(url.searchParams.get("indexing")).toBe("INDEXED");
    expect(url.searchParams.get("scope")).toBe("WORKSPACE");
    expect(url.searchParams.get("q")).toBe("refund policy");
    expect(decodeKnowledgeCursor(url.searchParams.get("cursor") ?? undefined)).toEqual(CURSOR);
  });

  it("replaces the cursor rather than collecting them", () => {
    const href = knowledgeNextHref(BASE, { cursor: encodeKnowledgeCursor({ updatedAt: new Date("2026-09-30T12:00:00.000Z"), id: "kd_1" }), q: "hours" }, CURSOR);

    const cursors = new URL(href, "https://example.test").searchParams.getAll("cursor");
    expect(cursors).toHaveLength(1);
    expect(decodeKnowledgeCursor(cursors[0])).toEqual(CURSOR);
  });

  it("drops the one-shot outcome notice", () => {
    // `outcome` announces a write that already happened. Carrying it to page two would announce it again.
    const href = knowledgeNextHref(BASE, { outcome: "knowledge.saved", q: "hours" }, CURSOR);

    expect(new URL(href, "https://example.test").searchParams.has("outcome")).toBe(false);
  });

  it("ignores empty and repeated parameters, which is what a submitted form leaves behind", () => {
    const href = knowledgeNextHref(BASE, { status: "", q: ["hours", "ignored"] }, CURSOR);

    const params = new URL(href, "https://example.test").searchParams;
    expect(params.has("status")).toBe(false);
    expect(params.get("q")).toBe("hours");
  });
});
