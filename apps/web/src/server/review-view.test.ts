/**
 * What a Review queue URL is allowed to ask for (Issue #29).
 *
 * The hostile cases are the point: a reason code nobody defined, a view nobody defined, a repeated
 * parameter. Each has to widen to the whole queue rather than reach a query — showing more than was asked
 * for is visible on screen, while an invented enum value is a 500 on a link somebody shared.
 */
import { describe, expect, it } from "vitest";

import { isFilteredReviewView, parseReviewView, reviewFilterOf, reviewQueryString } from "./review-view";

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
