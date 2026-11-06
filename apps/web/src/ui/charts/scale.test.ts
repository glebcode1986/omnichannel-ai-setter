/**
 * The arithmetic under the charts, which is where a chart lies without looking wrong.
 *
 * Every case here is a way the picture can disagree with the numbers printed beside it: a day dropped
 * from the axis, an axis that rescales itself so every window looks the same, a bar drawn past the end of
 * its track. None of them throws, and none of them is visible in a screenshot.
 */
import { describe, expect, it } from "vitest";

import { localDays, niceTop, sharePercent } from "./scale";

const utc = (iso: string): Date => new Date(iso);

describe("the days a chart's axis covers", () => {
  it("returns every local day in the window, so a quiet day is empty rather than missing", () => {
    const days = localDays({ from: utc("2026-10-01T00:00:00Z"), to: utc("2026-10-08T00:00:00Z"), timeZone: "UTC" });

    expect(days).toEqual(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"]);
  });

  it("ends at the day containing the last moment, because the window's end is exclusive", () => {
    // A `to` of local midnight belongs to the next day and must not add a column for it.
    const days = localDays({ from: utc("2026-10-01T00:00:00Z"), to: utc("2026-10-02T00:00:00Z"), timeZone: "UTC" });

    expect(days).toEqual(["2026-10-01"]);
  });

  it("counts days in the requested zone and not in UTC", () => {
    // 22:30 UTC is already the next day in Madrid, which is the same two-conversion problem the store's
    // own SQL had to get right. One day of Madrid, spanning two UTC dates.
    const days = localDays({ from: utc("2026-10-22T22:00:00Z"), to: utc("2026-10-23T22:00:00Z"), timeZone: "Europe/Madrid" });

    expect(days).toEqual(["2026-10-23"]);
  });

  it("does not repeat or skip a date across a daylight-saving change", () => {
    // Madrid moves off summer time on 2026-10-25. These instants are local midnights either side of it:
    // the window covers four local days, two at +02:00 and two at +01:00.
    //
    // This is the case that fails if the walk steps by twenty-four hours instead of by calendar date.
    // Stepping by duration from 2026-10-22T22:00Z reaches 2026-10-25T22:00Z, which is 23:00 on the 25th
    // in Madrid — so the 25th is emitted twice, the 26th never, and the chart shows a day that does not
    // exist beside one that does.
    const days = localDays({ from: utc("2026-10-22T22:00:00Z"), to: utc("2026-10-26T23:00:00Z"), timeZone: "Europe/Madrid" });

    expect(days).toEqual(["2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26"]);
  });

  it("crosses a month and a year without inventing a 32nd", () => {
    const days = localDays({ from: utc("2026-12-30T00:00:00Z"), to: utc("2027-01-02T00:00:00Z"), timeZone: "UTC" });

    expect(days).toEqual(["2026-12-30", "2026-12-31", "2027-01-01"]);
  });

  it("includes the leap day in the year that has one", () => {
    const days = localDays({ from: utc("2028-02-28T00:00:00Z"), to: utc("2028-03-01T00:00:00Z"), timeZone: "UTC" });

    expect(days).toEqual(["2028-02-28", "2028-02-29"]);
  });

  it("has nothing to draw for a window that ends when it starts, or before", () => {
    const empty = { from: utc("2026-10-01T00:00:00Z"), to: utc("2026-10-01T00:00:00Z"), timeZone: "UTC" };

    expect(localDays(empty)).toEqual([]);
    expect(localDays({ ...empty, to: utc("2026-09-01T00:00:00Z") })).toEqual([]);
  });

  it("stops rather than running away on a window no preset can produce", () => {
    // The longest range this product offers is ninety days. A window of years is a caller's bug, and the
    // page hanging while it lays out forty thousand columns is a worse way to find out than a short axis.
    const days = localDays({ from: utc("2000-01-01T00:00:00Z"), to: utc("2030-01-01T00:00:00Z"), timeZone: "UTC" });

    expect(days.length).toBe(400);
    expect(days[0]).toBe("2000-01-01");
  });
});

describe("the top of an axis", () => {
  it("is a clean number at or above the tallest value", () => {
    // The point is that it does *not* track the data closely: a week with four messages and a week with
    // four hundred have to draw differently, and scaling to the largest value makes both full height.
    expect(niceTop(1)).toBe(1);
    expect(niceTop(3)).toBe(5);
    expect(niceTop(7)).toBe(10);
    expect(niceTop(12)).toBe(20);
    expect(niceTop(45)).toBe(50);
    expect(niceTop(50)).toBe(50);
    expect(niceTop(120)).toBe(200);
    expect(niceTop(880)).toBe(1000);
  });

  it("never comes back below the value it has to contain", () => {
    for (const value of [1, 2, 6, 9, 11, 19, 21, 49, 51, 99, 101, 499, 501, 4999]) {
      expect(niceTop(value), `${String(value)} must fit under its own ceiling`).toBeGreaterThanOrEqual(value);
    }
  });

  it("is zero when there is nothing to measure, which the callers read as nothing to draw", () => {
    expect(niceTop(0)).toBe(0);
    expect(niceTop(-5)).toBe(0);
    expect(niceTop(Number.NaN)).toBe(0);
    expect(niceTop(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("a bar's length", () => {
  it("is the share of the top, as a percentage", () => {
    expect(sharePercent(5, 10)).toBe("50.00%");
    expect(sharePercent(10, 10)).toBe("100.00%");
    expect(sharePercent(1, 3)).toBe("33.33%");
  });

  it("is exactly zero for zero, so the stylesheet's floor cannot draw a mark for nothing", () => {
    expect(sharePercent(0, 10)).toBe("0%");
    expect(sharePercent(-3, 10)).toBe("0%");
  });

  it("stays inside its track whatever it is given", () => {
    // Should not happen — a value above its own ceiling is a bug upstream — but a bar drawn past the end
    // of the track is a wrong picture rather than an error, so it is clamped where it is drawn.
    expect(sharePercent(20, 10)).toBe("100.00%");
    expect(sharePercent(5, 0)).toBe("0%");
    expect(sharePercent(Number.NaN, 10)).toBe("0%");
    expect(sharePercent(5, Number.NaN)).toBe("0%");
  });

  it("keeps a very small share distinguishable from none at all", () => {
    // One in five thousand is not zero, and the two must not arrive at the stylesheet as the same string:
    // the two-pixel floor applies to the first and not to the second.
    expect(sharePercent(1, 5000)).not.toBe("0%");
  });
});
