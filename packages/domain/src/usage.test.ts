/**
 * Cycle boundaries and reservation arithmetic (#39, USAGE_METERING.md).
 *
 * Two things are worth testing here and neither is the happy path. A cycle boundary decides which month a
 * business's consumption belongs to, so an off-by-one is a billing error; and a reservation decides
 * whether the last unit of an allowance can be sold twice.
 */
import { describe, expect, it } from "vitest";

import { DomainValidationError } from "./errors";
import {
  hasCustomerQuota,
  INTERNAL_USAGE_METRICS,
  ledgerDeltas,
  nextUsageCycle,
  reservationVerdict,
  usageCycleFor,
  type EntitlementSnapshot,
} from "./index";

const snapshot = (overrides: Partial<EntitlementSnapshot> = {}): EntitlementSnapshot => ({
  workspaceId: "ws_1",
  state: "ACTIVE",
  planCode: "growth",
  planVersion: 1,
  paidWorkAllowed: true,
  features: {
    AI_DRAFTS: true,
    AUTOPILOT: true,
    INSTAGRAM: true,
    WHATSAPP: true,
    WHATSAPP_TEMPLATE_AUTOPILOT: true,
    VOICE_TRANSCRIPTION: true,
    ADVANCED_ANALYTICS: true,
    MULTI_MEMBER: true,
  },
  limits: {},
  quotas: { VOICE_TRANSCRIPTION_SECONDS: 100 },
  resolvedAt: new Date("2026-10-07T00:00:00.000Z"),
  ...overrides,
});

describe("which metrics a plan can sell", () => {
  it("never sells an internal one", () => {
    // The commercial decision, stated in code: core AI generation is included and unmetered, so there is
    // no allowance an exhausted quota could hold a reply against.
    for (const metric of INTERNAL_USAGE_METRICS) {
      expect(hasCustomerQuota(metric)).toBe(false);
    }
  });

  it("sells the transcription allowance", () => {
    expect(hasCustomerQuota("VOICE_TRANSCRIPTION_SECONDS")).toBe(true);
  });
});

describe("the cycle an instant belongs to", () => {
  const at = (iso: string) => usageCycleFor(14, new Date(iso));

  it("starts on the anchor day and ends on the next one, exclusively", () => {
    const cycle = at("2026-10-20T12:00:00.000Z");

    expect(cycle.startsAt.toISOString()).toBe("2026-10-14T00:00:00.000Z");
    expect(cycle.endsAt.toISOString()).toBe("2026-11-14T00:00:00.000Z");
  });

  it("puts the anchor instant itself in the cycle it opens", () => {
    expect(at("2026-10-14T00:00:00.000Z").startsAt.toISOString()).toBe("2026-10-14T00:00:00.000Z");
  });

  it("puts the instant one tick before the anchor in the previous cycle", () => {
    // The half-open boundary, which is what stops an operation belonging to two cycles or to neither.
    const cycle = at("2026-10-13T23:59:59.999Z");

    expect(cycle.startsAt.toISOString()).toBe("2026-09-14T00:00:00.000Z");
    expect(cycle.endsAt.toISOString()).toBe("2026-10-14T00:00:00.000Z");
  });

  it("tiles the timeline exactly, so one cycle's end is the next one's start", () => {
    const first = at("2026-10-20T12:00:00.000Z");
    const second = nextUsageCycle(first);

    expect(second.startsAt.getTime()).toBe(first.endsAt.getTime());
    expect(usageCycleFor(14, first.endsAt).startsAt.getTime()).toBe(first.endsAt.getTime());
  });

  it("clamps an anchor the month does not have, without forgetting it", () => {
    const february = usageCycleFor(31, new Date("2027-02-10T00:00:00.000Z"));

    // January's 31st opened it; February has no 31st, so it closes on the 28th.
    expect(february.startsAt.toISOString()).toBe("2027-01-31T00:00:00.000Z");
    expect(february.endsAt.toISOString()).toBe("2027-02-28T00:00:00.000Z");

    // And March is the 31st again. A cycle that had kept the 28th would shorten every later month by
    // three days, which over a year is a month of allowance nobody decided to take away.
    const march = nextUsageCycle(february);
    expect(march.startsAt.toISOString()).toBe("2027-02-28T00:00:00.000Z");
    expect(march.endsAt.toISOString()).toBe("2027-03-31T00:00:00.000Z");
  });

  it("handles a leap February", () => {
    expect(usageCycleFor(30, new Date("2028-02-15T00:00:00.000Z")).endsAt.toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });

  it("crosses a year end", () => {
    const cycle = usageCycleFor(20, new Date("2027-01-05T00:00:00.000Z"));

    expect(cycle.startsAt.toISOString()).toBe("2026-12-20T00:00:00.000Z");
    expect(cycle.endsAt.toISOString()).toBe("2027-01-20T00:00:00.000Z");
  });

  it("is computed in UTC, so a boundary does not move with daylight saving", () => {
    // Two instants either side of a European clock change, in the same cycle, with the boundary unmoved.
    const before = usageCycleFor(1, new Date("2026-10-24T12:00:00.000Z"));
    const after = usageCycleFor(1, new Date("2026-10-26T12:00:00.000Z"));

    expect(after.startsAt.toISOString()).toBe(before.startsAt.toISOString());
    expect(before.startsAt.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("refuses an anchor that is not a day of month", () => {
    expect(() => usageCycleFor(0, new Date())).toThrow(DomainValidationError);
    expect(() => usageCycleFor(32, new Date())).toThrow(DomainValidationError);
    expect(() => usageCycleFor(Number.NaN, new Date())).toThrow(DomainValidationError);
  });
});

describe("whether an allowance may be held", () => {
  const verdict = (overrides: { committed?: number; reserved?: number; amount?: number; snapshot?: EntitlementSnapshot } = {}) =>
    reservationVerdict({
      snapshot: overrides.snapshot ?? snapshot(),
      metric: "VOICE_TRANSCRIPTION_SECONDS",
      committed: overrides.committed ?? 0,
      reserved: overrides.reserved ?? 0,
      amount: overrides.amount ?? 10,
    });

  it("allows a hold inside the allowance", () => {
    expect(verdict({ committed: 50, amount: 50 })).toEqual({ kind: "ALLOWED" });
  });

  it("counts other reservations against the allowance, not only what was spent", () => {
    // The last unit, sold twice: without this the two concurrent callers would each be told there is room.
    expect(verdict({ committed: 50, reserved: 50, amount: 1 })).toMatchObject({ kind: "EXHAUSTED", remaining: 0 });
  });

  it("reports how much is left, so the refusal can be explained", () => {
    expect(verdict({ committed: 90, amount: 20 })).toEqual({ kind: "EXHAUSTED", allowance: 100, used: 90, remaining: 10 });
  });

  it("refuses to reserve an internal metric rather than quietly succeeding", () => {
    // A reservation that did nothing would leave its caller believing it had checked something.
    expect(
      reservationVerdict({ snapshot: snapshot(), metric: "AI_GENERATION_CYCLES", committed: 0, reserved: 0, amount: 1 }),
    ).toEqual({ kind: "NOT_A_QUOTA" });
  });

  it("tells a plan that includes none of it apart from an allowance that is spent", () => {
    // Different answers for the person reading them: one is fixed by changing plan, the other by waiting.
    expect(verdict({ snapshot: snapshot({ quotas: {} }) })).toEqual({ kind: "NOT_INCLUDED" });
  });

  it("refuses when paid work is stopped, whatever the allowance says", () => {
    expect(verdict({ snapshot: snapshot({ state: "INACTIVE", paidWorkAllowed: false }) })).toEqual({ kind: "NO_PAID_ACCESS" });
  });

  it("refuses a meaningless amount loudly, because it is a bug and not a business answer", () => {
    expect(() => verdict({ amount: 0 })).toThrow(DomainValidationError);
    expect(() => verdict({ amount: -5 })).toThrow(DomainValidationError);
  });
});

describe("what one ledger row does to the counters", () => {
  it("records consumption straight into the committed total", () => {
    expect(ledgerDeltas("RECORD", { amount: 3 })).toEqual({ committed: 3, reserved: 0 });
  });

  it("holds a reservation without consuming anything", () => {
    expect(ledgerDeltas("RESERVE", { amount: 30 })).toEqual({ committed: 0, reserved: 30 });
  });

  it("hands the hold over on commit, for whatever was actually used", () => {
    // Transcription reserves an estimate and commits the real duration, so the two differ by design.
    expect(ledgerDeltas("COMMIT", { amount: 22, held: 30 })).toEqual({ committed: 22, reserved: -30 });
  });

  it("gives the whole hold back on release, consuming nothing", () => {
    expect(ledgerDeltas("RELEASE", { amount: 0, held: 30 })).toEqual({ committed: 0, reserved: -30 });
  });

  it("refuses to settle a reservation without saying what it held", () => {
    // A silently-zero hold leaks allowance for the rest of the cycle, which nobody notices until the
    // allowance is unusable.
    expect(() => ledgerDeltas("COMMIT", { amount: 10 })).toThrow(DomainValidationError);
    expect(() => ledgerDeltas("RELEASE", { amount: 0 })).toThrow(DomainValidationError);
  });

  it("commits more than was held when the work turned out larger", () => {
    // The work happened. A ledger that recorded less than was consumed would understate our own costs,
    // and it is the *next* reservation that is refused rather than this one being trimmed.
    expect(ledgerDeltas("COMMIT", { amount: 45, held: 30 })).toEqual({ committed: 45, reserved: -30 });
  });
});
