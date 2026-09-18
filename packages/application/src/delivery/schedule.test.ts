import { describe, expect, it } from "vitest";

import { NATURAL_MODE_FRACTION, selectDeliveryDelayMs } from "./schedule";

const RANGE = { minMs: 30_000, maxMs: 120_000 };

/** A deterministic stand-in for randomness, so a distribution can be asserted rather than sampled. */
const fixed = (value: number) => () => value;

describe("the natural delay", () => {
  it("stays inside the configured range at both extremes", () => {
    const low = selectDeliveryDelayMs({ range: RANGE, random: fixed(0) });
    const high = selectDeliveryDelayMs({ range: RANGE, random: fixed(0.999_999) });

    expect(low).toMatchObject({ kind: "DELAY", delayMs: 30_000 });
    expect(high.kind === "DELAY" ? high.delayMs : 0).toBeLessThanOrEqual(120_000);
    expect(high.kind === "DELAY" ? high.delayMs : 0).toBeGreaterThan(110_000);
  });

  it("clusters around a minute rather than spreading evenly", () => {
    const samples = Array.from({ length: 1_000 }, (_unused, index) =>
      selectDeliveryDelayMs({ range: RANGE, random: fixed((index + 0.5) / 1_000) }),
    ).map((delay) => (delay.kind === "DELAY" ? delay.delayMs : 0));

    const mean = samples.reduce((total, value) => total + value, 0) / samples.length;
    // Mode at a third of the range puts the mean near 30 + (30+120+60)/3 ≈ 70 s. A uniform sample would
    // sit at 75 s and make a 30-second reply exactly as likely as a 119-second one, which reads as a
    // machine choosing at random.
    expect(mean).toBeGreaterThan(62_000);
    expect(mean).toBeLessThan(76_000);

    const nearMode = samples.filter((value) => value > 45_000 && value < 75_000).length;
    const nearMax = samples.filter((value) => value > 105_000).length;
    expect(nearMode).toBeGreaterThan(nearMax * 3);
  });

  it("peaks where the configured mode fraction says", () => {
    expect(NATURAL_MODE_FRACTION).toBeCloseTo(1 / 3, 10);

    const skewedLate = Array.from({ length: 200 }, (_unused, index) =>
      selectDeliveryDelayMs({ range: RANGE, random: fixed((index + 0.5) / 200), modeFraction: 0.9 }),
    ).map((delay) => (delay.kind === "DELAY" ? delay.delayMs : 0));
    const mean = skewedLate.reduce((total, value) => total + value, 0) / skewedLate.length;

    expect(mean).toBeGreaterThan(85_000);
  });

  it("refuses a random source outside [0, 1)", () => {
    expect(() => selectDeliveryDelayMs({ range: RANGE, random: fixed(1) })).toThrow(RangeError);
    expect(() => selectDeliveryDelayMs({ range: RANGE, random: fixed(Number.NaN) })).toThrow(RangeError);
    expect(() => selectDeliveryDelayMs({ range: RANGE, random: fixed(0.5), modeFraction: 2 })).toThrow(RangeError);
  });

  it("returns the single value when the range has no width", () => {
    expect(selectDeliveryDelayMs({ range: { minMs: 5_000, maxMs: 5_000 }, random: fixed(0.5) })).toMatchObject({ delayMs: 5_000 });
  });
});

describe("the provider's budget wins", () => {
  it("leaves a delay alone when it fits", () => {
    const delay = selectDeliveryDelayMs({ range: RANGE, random: fixed(0.2), remainingBudgetMs: 300_000 });

    expect(delay).toMatchObject({ kind: "DELAY", shortened: false });
  });

  it("shortens a delay that would overrun, and says that it did", () => {
    const delay = selectDeliveryDelayMs({ range: RANGE, random: fixed(0.9), remainingBudgetMs: 20_000 });

    // There is still time to answer, just not enough to look leisurely about it. The flag is what lets an
    // audit trail show the provider overrode the product.
    expect(delay).toEqual({ kind: "DELAY", delayMs: 20_000, shortened: true });
  });

  it("gives up entirely once the budget is spent", () => {
    // Sending anyway to preserve "human-like timing" would break the rule the timing exists to respect.
    expect(selectDeliveryDelayMs({ range: RANGE, random: fixed(0.1), remainingBudgetMs: 0 })).toEqual({ kind: "DEADLINE_MISSED" });
    expect(selectDeliveryDelayMs({ range: RANGE, random: fixed(0.1), remainingBudgetMs: -1 })).toEqual({ kind: "DEADLINE_MISSED" });
  });

  it("fits Instagram's automated budget by shortening, not by skipping the delay", () => {
    // 25 s target from the owner's decision on Issue #13, with generation already having eaten some of it.
    const delay = selectDeliveryDelayMs({ range: RANGE, random: fixed(0.5), remainingBudgetMs: 12_000 });

    expect(delay).toEqual({ kind: "DELAY", delayMs: 12_000, shortened: true });
  });
});
