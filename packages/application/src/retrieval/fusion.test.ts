import { describe, expect, it } from "vitest";

import { fuseByReciprocalRank, RRF_K, type RankedCandidate } from "./fusion";

const workspace = (id: string): RankedCandidate => ({ id, scopeLevel: "WORKSPACE" });
const profile = (id: string): RankedCandidate => ({ id, scopeLevel: "BUSINESS_PROFILE" });

describe("reciprocal rank fusion", () => {
  it("scores by position only, so two incomparable scales never have to be converted", () => {
    const fused = fuseByReciprocalRank([[workspace("a"), workspace("b")], [workspace("b")]], { limit: 10 });

    // b: 1/(60+2) from the first list plus 1/(60+1) from the second. a: 1/(60+1).
    expect(fused[0]).toMatchObject({ id: "b", ranks: [2, 1] });
    expect(fused[0]?.score).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 1), 12);
    expect(fused[1]).toMatchObject({ id: "a", ranks: [1, undefined] });
    // Agreement between two lists beats being first in one: that is the entire point of fusing.
    expect(fused[0]?.score).toBeGreaterThan(fused[1]?.score ?? 0);
  });

  it("orders identically no matter how the same candidates arrive", () => {
    const left = [workspace("x"), workspace("y"), workspace("z")];
    const right = [workspace("z"), workspace("x")];

    const once = fuseByReciprocalRank([left, right], { limit: 10 });
    const again = fuseByReciprocalRank([[...left], [...right]], { limit: 10 });

    expect(once.map((entry) => entry.id)).toEqual(again.map((entry) => entry.id));
    // Summation order is fixed too, so the scores are bit-for-bit equal and an audit row is reproducible.
    expect(once.map((entry) => entry.score)).toEqual(again.map((entry) => entry.score));
  });

  it("breaks a tie by scope and then by ID rather than by map order", () => {
    // Both appear once, at rank 1 of their own list: identical scores, and the order must still be fixed.
    const first = fuseByReciprocalRank([[workspace("zzz")], [profile("aaa")]], { limit: 10 });
    const swapped = fuseByReciprocalRank([[profile("aaa")], [workspace("zzz")]], { limit: 10 });

    expect(first[0]?.score).toBe(first[1]?.score);
    // Profile-specific material is the more specific answer for this Business Profile, so it leads.
    expect(first.map((entry) => entry.id)).toEqual(["aaa", "zzz"]);
    expect(swapped.map((entry) => entry.id)).toEqual(["aaa", "zzz"]);

    const sameScope = fuseByReciprocalRank([[workspace("b")], [workspace("a")]], { limit: 10 });
    expect(sameScope.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("counts a candidate once per list even if a list repeats it", () => {
    const fused = fuseByReciprocalRank([[workspace("a"), workspace("a"), workspace("b")]], { limit: 10 });

    // The first position wins; scoring it twice would let one list outvote the other by repeating itself.
    expect(fused[0]).toMatchObject({ id: "a", ranks: [1] });
    expect(fused[0]?.score).toBeCloseTo(1 / (RRF_K + 1), 12);
    expect(fused).toHaveLength(2);
  });

  it("applies the limit after fusing, and survives degenerate limits", () => {
    const lists = [[workspace("a"), workspace("b"), workspace("c")]];

    expect(fuseByReciprocalRank(lists, { limit: 2 }).map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(fuseByReciprocalRank(lists, { limit: 0 })).toEqual([]);
    expect(fuseByReciprocalRank(lists, { limit: -5 })).toEqual([]);
    expect(fuseByReciprocalRank([[], []], { limit: 5 })).toEqual([]);
  });

  it("keeps a slot for every list, so a caller can tell which list found what", () => {
    const fused = fuseByReciprocalRank([[], [workspace("a")], []], { limit: 5 });

    expect(fused[0]?.ranks).toEqual([undefined, 1, undefined]);
  });
});
