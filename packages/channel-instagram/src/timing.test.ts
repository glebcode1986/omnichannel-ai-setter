import { describe, expect, it } from "vitest";

import {
  DEFAULT_AUTOMATED_DISPATCH_TARGET_MS,
  DEFAULT_AUTOMATED_RESPONSE_BUDGET_MS,
  instagramTimingPolicy,
  remainingAutomatedDispatchMs,
} from "./timing";

describe("provider timing policy", () => {
  it("reports the verified Meta budget with a safety margin", () => {
    expect(instagramTimingPolicy()).toEqual({ automatedResponseBudgetMs: 30_000, automatedDispatchTargetMs: 25_000 });
    // The target must leave room for generation and queue latency inside the provider's cap.
    expect(DEFAULT_AUTOMATED_DISPATCH_TARGET_MS).toBeLessThan(DEFAULT_AUTOMATED_RESPONSE_BUDGET_MS);
  });

  it("is configuration, so a changed Meta rule needs no code change", () => {
    expect(instagramTimingPolicy({ automatedResponseBudgetMs: 60_000, automatedDispatchTargetMs: 45_000 })).toEqual({
      automatedResponseBudgetMs: 60_000,
      automatedDispatchTargetMs: 45_000,
    });
    // A target beyond the cap would defeat the margin, so it is clamped rather than accepted.
    expect(instagramTimingPolicy({ automatedResponseBudgetMs: 10_000, automatedDispatchTargetMs: 20_000 })).toEqual({
      automatedResponseBudgetMs: 10_000,
      automatedDispatchTargetMs: 10_000,
    });
    expect(() => instagramTimingPolicy({ automatedResponseBudgetMs: 0 })).toThrow(RangeError);
    expect(() => instagramTimingPolicy({ automatedDispatchTargetMs: -1 })).toThrow(RangeError);
  });

  it("counts the time left from the person's message, and goes negative once the deadline passed", () => {
    const inboundAt = new Date("2026-09-17T12:00:00.000Z");

    expect(remainingAutomatedDispatchMs(inboundAt, new Date("2026-09-17T12:00:05.000Z"))).toBe(20_000);
    expect(remainingAutomatedDispatchMs(inboundAt, new Date("2026-09-17T12:00:25.000Z"))).toBe(0);
    // Past the target the caller must hold or review; the adapter does not decide that, it only reports.
    expect(remainingAutomatedDispatchMs(inboundAt, new Date("2026-09-17T12:00:40.000Z"))).toBe(-15_000);
  });
});
