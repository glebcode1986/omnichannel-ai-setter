/**
 * What a minted billing event guarantees about its own contents (#46, ADR-019).
 *
 * `billing-events.ts` makes a security claim in prose — that a caller holding a verified event cannot
 * edit the amount in it and hand it on — and for a while the code did not keep it. `Object.freeze` is
 * shallow and the spread it was given was shallow too, so the minted event shared its `settled` object
 * and its `Date`s with the adapter that produced them. The adapter could raise the amount afterwards, and
 * anybody holding the event could call `periodEndsAt.setUTCFullYear`, and a `WeakSet` membership test
 * could not see either. Astra demonstrated it on PR #100.
 *
 * These cases exist because that class of defect is invisible to every other gate: the types say
 * `readonly`, the suite passed, and the only thing wrong was that the guarantee was not true. So each one
 * performs the mutation rather than asserting the shape — a test that checked for `Object.isFrozen` would
 * have passed against the defect too.
 *
 * No infrastructure: minting and asserting are in-process, which is also why this is the fast gate's job
 * rather than the integration suite's.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertVerifiedBillingEvent,
  clearBillingProviders,
  registerBillingProvider,
  verifyProviderDelivery,
  type NormalizedBillingEvent,
  type VerifiedBillingEvent,
} from "./billing-events";
import { DbInputError } from "./errors";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const PERIOD_END = new Date("2026-11-07T12:00:00.000Z");

describe("a minted verified billing event", () => {
  /**
   * The event the stub adapter will hand back, kept here so a case can mutate the adapter's *own*
   * references after minting — which is the half a snapshot has to defeat.
   */
  let normalized: {
    routeCode: string;
    providerEventId: string;
    kind: NormalizedBillingEvent["kind"];
    occurredAt: Date;
    settled: { amountMinor: number; currency: string };
    settledAt: Date;
    periodEndsAt: Date;
  };

  beforeEach(() => {
    normalized = {
      routeCode: "direct-eu",
      providerEventId: "evt-1",
      kind: "PAYMENT_SETTLED",
      occurredAt: new Date(NOW.getTime()),
      settled: { amountMinor: 4_900, currency: "EUR" },
      settledAt: new Date(NOW.getTime()),
      periodEndsAt: new Date(PERIOD_END.getTime()),
    };
    registerBillingProvider({
      provider: "test-psp",
      // The port's delivery is a union now: an adapter says whether it authenticated an event at all,
      // separately from what the event was. The cases below are unchanged — what they mutate is still the
      // adapter's own object, reached through `normalized`.
      verify: () => ({ kind: "EVENT" as const, event: normalized }),
    });
  });

  afterEach(() => {
    clearBillingProviders();
  });

  const mint = async (): Promise<VerifiedBillingEvent> => {
    const delivered = await verifyProviderDelivery({ provider: "test-psp", body: "raw", headers: {}, receivedAt: NOW });
    if (delivered.kind !== "EVENT") {
      throw new Error(`the stub adapter refused its own delivery: ${delivered.kind}`);
    }
    return delivered.event;
  };

  it("is accepted as verified when nothing has touched it", async () => {
    // The control. Every refusal below is only meaningful because this one passes: without it, a mint that
    // produced an event the assertion always rejected would look like perfect tamper detection.
    const event = await mint();
    expect(() => {
      assertVerifiedBillingEvent(event);
    }).not.toThrow();
  });

  it("does not share its money with the adapter that produced it", async () => {
    const event = await mint();

    // The adapter still holds the object it returned. Before the fix this *was* the event's own `settled`,
    // so raising it here raised the authenticated amount.
    normalized.settled.amountMinor = 10_000;

    expect(event.settled?.amountMinor).toBe(4_900);
    expect(() => {
      assertVerifiedBillingEvent(event);
    }).not.toThrow();
  });

  it("does not share its dates with the adapter either", async () => {
    const event = await mint();

    normalized.periodEndsAt.setUTCFullYear(2099);
    normalized.occurredAt.setUTCFullYear(2099);
    normalized.settledAt.setUTCFullYear(2099);

    expect(event.periodEndsAt?.getTime()).toBe(PERIOD_END.getTime());
    expect(event.occurredAt.getTime()).toBe(NOW.getTime());
    expect(event.settledAt?.getTime()).toBe(NOW.getTime());
    expect(() => {
      assertVerifiedBillingEvent(event);
    }).not.toThrow();
  });

  it("stops being verified once somebody edits the date inside it", async () => {
    // A `Date` cannot be made immutable, so the guarantee is not that this edit is impossible — it is that
    // an edited event is no longer the event that was authenticated. `periodEndsAt` is the field that
    // decides how long a workspace keeps paid access, which is why it is the one worth proving.
    const event = await mint();
    event.periodEndsAt?.setUTCFullYear(2099);

    expect(() => {
      assertVerifiedBillingEvent(event);
    }).toThrow(DbInputError);
  });

  it("stops being verified once somebody edits the instant it occurred", async () => {
    // `occurredAt` orders a reversal against the payment that bought the current term, so moving it is how
    // an old refund would be made to look like a new one.
    const event = await mint();
    event.occurredAt.setUTCFullYear(2099);

    expect(() => {
      assertVerifiedBillingEvent(event);
    }).toThrow(DbInputError);
  });

  it("refuses an object this module never minted, however well shaped", () => {
    const forged = {
      routeCode: "direct-eu",
      providerEventId: "evt-1",
      kind: "PAYMENT_SETTLED",
      occurredAt: new Date(NOW.getTime()),
      settled: { amountMinor: 4_900, currency: "EUR" },
      settledAt: new Date(NOW.getTime()),
      periodEndsAt: new Date(PERIOD_END.getTime()),
      activationSource: "VERIFIED_EVENT",
    };

    expect(() => {
      // Exactly the shape a success-page handler could assemble, including the brand field, and cast the
      // way such a handler would have to cast it.
      assertVerifiedBillingEvent(forged as Parameters<typeof assertVerifiedBillingEvent>[0]);
    }).toThrow(DbInputError);
  });

  it("keeps its own fields unwritable", async () => {
    const event = await mint();

    expect(() => {
      // `freeze` still earns its place: it stops the simplest edit of all, replacing the field outright.
      (event as { settled?: { amountMinor: number; currency: string } }).settled = { amountMinor: 1, currency: "EUR" };
    }).toThrow(TypeError);
    expect(event.settled?.amountMinor).toBe(4_900);
  });
});
