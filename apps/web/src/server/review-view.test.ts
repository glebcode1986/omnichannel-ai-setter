/**
 * What a Review queue URL is allowed to ask for (Issue #29).
 *
 * The hostile cases are the point: a reason code nobody defined, a view nobody defined, a repeated
 * parameter. Each has to widen to the whole queue rather than reach a query — showing more than was asked
 * for is visible on screen, while an invented enum value is a 500 on a link somebody shared.
 */
import { describe, expect, it } from "vitest";

import {
  decodeReviewCursor,
  encodeReviewCursor,
  isFilteredReviewView,
  parseReviewView,
  reviewFilterOf,
  reviewNextHref,
  reviewQueryString,
} from "./review-view";

describe("parsing a Review queue URL", () => {
  it("reads a reason the domain defines", () => {
    expect(parseReviewView({ reason: "MISSING_FACT" })).toEqual({ reasonCode: "MISSING_FACT" });
  });

  it("drops a reason nobody defined, and one in the wrong case", () => {
    expect(parseReviewView({ reason: "VIBES" })).toEqual({});
    expect(parseReviewView({ reason: "missing_fact" })).toEqual({});
  });

  it("reads the two views it knows and ignores anything else", () => {
    expect(parseReviewView({ view: "stale" }).view).toBe("stale");
    expect(parseReviewView({ view: "answerable" }).view).toBe("answerable");
    expect(parseReviewView({ view: "urgent" }).view).toBeUndefined();
  });

  it("takes the first value when a parameter is repeated", () => {
    expect(parseReviewView({ view: ["stale", "answerable"] }).view).toBe("stale");
  });

  it("treats a blank parameter as absent", () => {
    expect(parseReviewView({ reason: "", view: "" })).toEqual({});
  });

  it("reads a reason and a view together", () => {
    expect(parseReviewView({ reason: "PAYMENT_DISPUTE", view: "answerable" })).toEqual({
      reasonCode: "PAYMENT_DISPUTE",
      view: "answerable",
    });
  });
});

describe("the store filter a Review view asks for", () => {
  it("asks for one reason", () => {
    expect(reviewFilterOf({ reasonCode: "LOW_CONFIDENCE" })).toEqual({ reasonCode: "LOW_CONFIDENCE" });
  });

  it("maps the two views onto staleness, which are opposite filters and not the same one", () => {
    expect(reviewFilterOf({ view: "stale" })).toEqual({ stale: true });
    expect(reviewFilterOf({ view: "answerable" })).toEqual({ stale: false });
  });

  it("asks for nothing when nothing was asked for, rather than defaulting to a subset", () => {
    // `{}` means the whole queue. `{ stale: false }` would quietly hide every overtaken item, and nobody
    // would ever clear them.
    expect(reviewFilterOf({})).toEqual({});
  });

  it("combines a reason with a view", () => {
    expect(reviewFilterOf({ reasonCode: "MISSING_FACT", view: "stale" })).toEqual({ reasonCode: "MISSING_FACT", stale: true });
  });
});

describe("the query string it builds back", () => {
  it("is empty for the whole queue", () => {
    expect(reviewQueryString({})).toBe("");
  });

  it("round-trips a view through a URL", () => {
    const view = { reasonCode: "HUMAN_AGENT_REVIEW_REQUIRED", view: "answerable" } as const;

    expect(parseReviewView(Object.fromEntries(new URLSearchParams(reviewQueryString(view)).entries()))).toEqual(view);
  });

  it("knows when the queue is being narrowed", () => {
    expect(isFilteredReviewView({})).toBe(false);
    expect(isFilteredReviewView({ view: "stale" })).toBe(true);
    expect(isFilteredReviewView({ reasonCode: "MISSING_FACT" })).toBe(true);
  });
});

describe("paging the queue", () => {
  const CURSOR = { createdAt: new Date("2026-09-30T11:00:00.000Z"), id: "ad_25" };
  const PATH = "/workspaces/ws_1/profiles/bp_1/review";

  it("round-trips a cursor through a URL", () => {
    expect(decodeReviewCursor(encodeReviewCursor(CURSOR))).toEqual(CURSOR);
    // URL-safe: no `+`, no `/`, no padding for something well-meaning to strip.
    expect(encodeReviewCursor(CURSOR)).toMatch(/^[A-Za-z0-9_-]+$/u);
  });

  it("refuses anything this module did not write, so a hand-edited URL shows page one", () => {
    for (const nonsense of [undefined, "", "not-a-cursor", Buffer.from("no-separator", "utf8").toString("base64url"), Buffer.from("not-a-date|ad_1", "utf8").toString("base64url"), Buffer.from("2026-09-30T11:00:00.000Z|", "utf8").toString("base64url")]) {
      expect(decodeReviewCursor(nonsense)).toBeUndefined();
    }
  });

  it("reads a cursor out of the query", () => {
    const encoded = encodeReviewCursor(CURSOR);

    expect(parseReviewView({ cursor: encoded, view: "stale" })).toEqual({ cursor: encoded, view: "stale" });
  });

  it("keeps the filter in the next link", () => {
    const href = reviewNextHref(PATH, { reasonCode: "MISSING_FACT", view: "answerable" }, CURSOR);

    const url = new URL(href, "https://example.test");
    expect(url.pathname).toBe(PATH);
    expect(url.searchParams.get("reason")).toBe("MISSING_FACT");
    expect(url.searchParams.get("view")).toBe("answerable");
    expect(decodeReviewCursor(url.searchParams.get("cursor") ?? undefined)).toEqual(CURSOR);
  });

  it("builds a valid link for the unfiltered queue too", () => {
    // `?` rather than `&` when there is nothing before it, which is the kind of thing that only breaks
    // on the one page nobody filtered.
    const url = new URL(reviewNextHref(PATH, {}, CURSOR), "https://example.test");

    expect(url.search.startsWith("?cursor=")).toBe(true);
    expect(decodeReviewCursor(url.searchParams.get("cursor") ?? undefined)).toEqual(CURSOR);
  });

  it("drops the cursor from every filter link, rather than landing mid-list", () => {
    // A filter link that kept the cursor would show page two of a list the operator has not seen the
    // start of. Changing what the queue shows means starting from the top of it.
    const encoded = encodeReviewCursor(CURSOR);

    expect(reviewQueryString({ reasonCode: "MISSING_FACT", cursor: encoded })).toBe("?reason=MISSING_FACT");
    expect(reviewQueryString({ cursor: encoded })).toBe("");
  });

  it("does not call page two of the whole queue a filtered view", () => {
    // Otherwise an empty last page explains itself with a filter nobody applied.
    expect(isFilteredReviewView({ cursor: encodeReviewCursor(CURSOR) })).toBe(false);
  });
});
