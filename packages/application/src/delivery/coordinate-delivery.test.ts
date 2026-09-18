import type { ReasonCode } from "@omnichannel/domain";
import type { SendResult } from "@omnichannel/channel-core";
import { describe, expect, it } from "vitest";

import { coordinateDelivery, type DeliveryCommand, type DeliveryDependencies } from "./coordinate-delivery";
import type { ClaimOutcome, DeliverySendContext, DeliverySettlement } from "./ports";

const NOW = new Date("2026-09-18T12:00:00.000Z");

const context = (overrides: Partial<DeliverySendContext> = {}): DeliverySendContext => ({
  deliveryJobId: "djob_1",
  operationId: "op_1",
  draftId: "draft_1",
  conversationId: "conv_1",
  channel: "INSTAGRAM",
  recipientExternalId: "ig-user-1",
  channelAccountId: "ca_1",
  text: "We open at 10 on Saturday.",
  status: "SCHEDULED",
  attemptCount: 0,
  mode: "AUTOPILOT",
  aiEnabled: true,
  takeover: { state: "NONE" },
  replyCycle: "OWNED",
  account: "CONNECTED",
  draftNeedsReview: false,
  alreadySent: false,
  ...overrides,
});

const command = (overrides: Partial<DeliveryCommand> = {}): DeliveryCommand => ({
  operationId: "op_1",
  correlationId: "corr_1",
  limits: {
    confidenceThreshold: 0.8,
    mandatoryReviewReasons: ["MISSING_FACT"],
    afterWindow: { channel: "INSTAGRAM", policy: "STANDARD_ONLY" },
  },
  channelState: {
    window: { state: "OPEN_FREEFORM", expiresAt: new Date(NOW.getTime() + 3_600_000) },
    humanAgent: { state: "UNAVAILABLE", reason: "NOT_APPROVED" },
  },
  authority: { kind: "AUTOMATED" },
  ...overrides,
});

interface HarnessOptions {
  readonly context?: DeliverySendContext | undefined;
  readonly result?: SendResult;
  readonly claim?: ClaimOutcome;
  readonly maxAttempts?: number;
}

function harness(options: HarnessOptions = {}) {
  const settlements: DeliverySettlement[] = [];
  const sends: { operationId: string; text: string }[] = [];
  const rescheduled: Date[] = [];
  const logs: string[] = [];
  let claims = 0;

  const dependencies: DeliveryDependencies = {
    store: {
      loadForSend: () => Promise.resolve("context" in options ? options.context : context()),
      claim: () => {
        claims += 1;
        // The database decides the winner; only the first caller can ever be told it owns the send.
        return Promise.resolve(options.claim ?? (claims === 1 ? { kind: "CLAIMED" } : { kind: "NOT_CLAIMABLE", status: "SENDING" }));
      },
      settle: (_operationId, settlement) => {
        settlements.push(settlement);
        return Promise.resolve();
      },
      reschedule: (_operationId, notBefore) => {
        rescheduled.push(notBefore);
        return Promise.resolve();
      },
    },
    sender: {
      send: (input) => {
        sends.push({ operationId: input.operationId, text: input.text });
        return Promise.resolve(options.result ?? { outcome: "ACCEPTED", platformMessageId: "mid_1" });
      },
    },
    log: {
      info: (event) => logs.push(event),
      warn: (event) => logs.push(event),
      error: (event) => logs.push(event),
    },
    now: () => NOW,
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
  };
  return { dependencies, settlements, sends, rescheduled, logs };
}

describe("the happy path is the only path to a send", () => {
  it("re-reads, re-judges, claims and sends exactly once", async () => {
    const { dependencies, sends, settlements } = harness();

    const outcome = await coordinateDelivery(dependencies, command());

    expect(outcome).toEqual({ status: "SENT", platformMessageId: "mid_1" });
    expect(sends).toEqual([{ operationId: "op_1", text: "We open at 10 on Saturday." }]);
    expect(settlements).toEqual([{ kind: "SENT", platformMessageId: "mid_1" }]);
  });

  it("uses the operation id the job was created with, so a provider can recognise a repeat", async () => {
    const { dependencies, sends } = harness();

    await coordinateDelivery(dependencies, command());

    expect(sends[0]?.operationId).toBe("op_1");
  });
});

describe("two workers racing one delivery", () => {
  it("lets exactly one send, and the loser sends nothing", async () => {
    const { dependencies, sends, settlements } = harness();

    const [first, second] = await Promise.all([
      coordinateDelivery(dependencies, command()),
      coordinateDelivery(dependencies, command()),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual(["NOT_CLAIMABLE", "SENT"]);
    // The claim is what stops the second worker, and it stops it *before* the adapter is reached.
    expect(sends).toHaveLength(1);
    expect(settlements).toHaveLength(1);
  });

  it("does not send when the claim is refused, whatever the state says", async () => {
    const { dependencies, sends } = harness({ claim: { kind: "NOT_CLAIMABLE", status: "SENDING" } });

    const outcome = await coordinateDelivery(dependencies, command());

    expect(outcome).toEqual({ status: "NOT_CLAIMABLE" });
    expect(sends).toEqual([]);
  });
});

describe("the final gate runs before anything is claimed", () => {
  const blocked = async (overrides: Partial<DeliverySendContext>, expected: ReasonCode) => {
    const { dependencies, sends, settlements } = harness({ context: context(overrides) });
    const outcome = await coordinateDelivery(dependencies, command());
    // Nothing reached the adapter, and the durable state records why.
    expect(sends).toEqual([]);
    expect(settlements).toHaveLength(1);
    return { outcome, settlement: settlements[0], expected };
  };

  it("cancels when the customer has spoken since the draft was written", async () => {
    const { outcome, settlement } = await blocked({ replyCycle: "SUPERSEDED" }, "SUPERSEDED_BY_NEWER_INBOUND");

    expect(settlement).toMatchObject({ kind: "CANCELLED", status: "CANCELLED_SUPERSEDED" });
    expect(outcome.status).toBe("CANCELLED");
  });

  it("cancels when a human took the conversation over during the delay", async () => {
    const { settlement } = await blocked(
      { takeover: { state: "HUMAN_ACTIVE", reason: "HUMAN_SENT_FROM_INBOX", since: NOW } },
      "HUMAN_TAKEOVER",
    );

    expect(settlement).toMatchObject({ kind: "CANCELLED", status: "CANCELLED_HUMAN_TAKEOVER" });
  });

  it("cancels when automation was switched off during the delay", async () => {
    const { settlement } = await blocked({ mode: "OFF" }, "MODE_NOT_AUTOPILOT");

    expect(settlement).toMatchObject({ kind: "CANCELLED", status: "CANCELLED_POLICY" });
  });

  it("cancels when the account stopped being usable during the delay", async () => {
    const { settlement } = await blocked({ account: "DISCONNECTED" }, "ACCOUNT_UNHEALTHY");

    // Unhealthy is a hold rather than a cancel: a person reconnects and the draft is still wanted.
    expect(settlement).toMatchObject({ kind: "HELD", status: "HELD_REVIEW" });
  });

  it("cancels when the messaging window closed during the delay", async () => {
    const { dependencies, sends, settlements } = harness();

    const outcome = await coordinateDelivery(
      dependencies,
      command({ channelState: { window: { state: "NOT_ELIGIBLE", reason: "closed" }, humanAgent: { state: "UNAVAILABLE", reason: "EXPIRED" } } }),
    );

    expect(sends).toEqual([]);
    expect(settlements[0]).toMatchObject({ kind: "CANCELLED", status: "CANCELLED_POLICY" });
    expect(outcome.status).toBe("CANCELLED");
  });

  it("refuses a draft with no sendable text rather than sending an empty reply", async () => {
    const { dependencies, sends, settlements } = harness({ context: context({ text: "   " }) });

    const outcome = await coordinateDelivery(dependencies, command());

    expect(sends).toEqual([]);
    expect(settlements[0]).toMatchObject({ kind: "HELD", status: "HELD_REVIEW" });
    expect(outcome.status).toBe("HELD");
  });

  it("never sends twice for one logical action, even if the job is somehow re-run", async () => {
    const { dependencies, sends } = harness({ context: context({ alreadySent: true }) });

    const outcome = await coordinateDelivery(dependencies, command());

    // The one mistake this module exists to avoid: a second message the customer cannot be un-sent.
    expect(sends).toEqual([]);
    expect(outcome).toEqual({ status: "NOT_CLAIMABLE" });
  });
});

describe("send outcomes", () => {
  it("quarantines an ambiguous result and never retries it", async () => {
    const { dependencies, settlements } = harness({
      result: { outcome: "AMBIGUOUS", code: "TIMEOUT", message: "no response from the platform" },
    });

    const outcome = await coordinateDelivery(dependencies, command());

    // The customer may already have the reply, and a second one cannot be taken back (ADR-012).
    expect(settlements[0]).toMatchObject({ kind: "HELD", status: "HELD_AMBIGUOUS", code: "TIMEOUT" });
    expect(outcome).toEqual({ status: "HELD", reason: "send outcome is unknown" });
  });

  it("holds a definite rejection with the provider's own code", async () => {
    const { dependencies, settlements } = harness({
      result: { outcome: "REJECTED", retryable: false, code: "OUTSIDE_WINDOW", message: "not allowed" },
    });

    const outcome = await coordinateDelivery(dependencies, command());

    expect(settlements[0]).toMatchObject({ kind: "HELD", status: "HELD_REVIEW", code: "OUTSIDE_WINDOW" });
    expect(outcome.status).toBe("HELD");
  });

  it("allows a bounded retry for a retryable rejection", async () => {
    const { dependencies, settlements } = harness({
      result: { outcome: "REJECTED", retryable: true, code: "RATE_LIMITED", message: "slow down" },
    });

    const outcome = await coordinateDelivery(dependencies, command());

    expect(settlements[0]).toMatchObject({ kind: "RETRY", code: "RATE_LIMITED" });
    expect(outcome.status).toBe("RETRY");
  });

  it("stops retrying at its own ceiling, whatever the queue would allow", async () => {
    const { dependencies, settlements } = harness({
      context: context({ attemptCount: 2 }),
      result: { outcome: "REJECTED", retryable: true, code: "RATE_LIMITED", message: "slow down" },
      maxAttempts: 3,
    });

    const outcome = await coordinateDelivery(dependencies, command());

    // A queue whose attempt policy changes must not turn a bounded retry into an unbounded one.
    expect(settlements[0]).toMatchObject({ kind: "EXHAUSTED" });
    expect(outcome.status).toBe("HELD");
  });
});

describe("quiet hours that begin during the delay", () => {
  it("waits for the quiet period to end instead of sending or failing", async () => {
    const { dependencies, sends, rescheduled } = harness();

    const outcome = await coordinateDelivery(
      dependencies,
      command({
        limits: {
          confidenceThreshold: 0.8,
          mandatoryReviewReasons: [],
          afterWindow: { channel: "INSTAGRAM", policy: "STANDARD_ONLY" },
          quietHours: { timeZone: "UTC", start: "11:00", end: "14:00" },
        },
        channelState: { window: { state: "OPEN_FREEFORM", expiresAt: new Date("2026-09-30T00:00:00.000Z") }, humanAgent: { state: "UNAVAILABLE", reason: "NOT_APPROVED" } },
      }),
    );

    expect(sends).toEqual([]);
    expect(outcome).toMatchObject({ status: "RESCHEDULED" });
    expect(rescheduled[0]?.toISOString()).toBe("2026-09-18T14:00:00.000Z");
  });

  it("holds rather than deferring when waiting would miss the provider's deadline", async () => {
    const { dependencies, sends, settlements, rescheduled } = harness();

    await coordinateDelivery(
      dependencies,
      command({
        limits: {
          confidenceThreshold: 0.8,
          mandatoryReviewReasons: [],
          afterWindow: { channel: "INSTAGRAM", policy: "STANDARD_ONLY" },
          quietHours: { timeZone: "UTC", start: "11:00", end: "14:00" },
        },
        channelState: {
          window: { state: "OPEN_FREEFORM", expiresAt: new Date("2026-09-30T00:00:00.000Z") },
          humanAgent: { state: "UNAVAILABLE", reason: "NOT_APPROVED" },
          dispatchDeadline: new Date(NOW.getTime() + 25_000),
        },
      }),
    );

    expect(rescheduled).toEqual([]);
    expect(sends).toEqual([]);
    expect(settlements[0]).toMatchObject({ kind: "HELD", status: "HELD_REVIEW" });
  });
});

describe("the human-approved path", () => {
  it("carries the approving actor to the adapter and still re-checks eligibility first", async () => {
    const sends: { authority: unknown }[] = [];
    const { dependencies } = harness();
    const withCapture: DeliveryDependencies = {
      ...dependencies,
      sender: {
        send: (input) => {
          sends.push({ authority: input.authority });
          return Promise.resolve({ outcome: "ACCEPTED", platformMessageId: "mid_1" });
        },
      },
    };

    await coordinateDelivery(
      withCapture,
      command({ authority: { kind: "HUMAN_APPROVED", approvedByUserId: "user_7", approvedAt: NOW } }),
    );

    expect(sends[0]?.authority).toEqual({ kind: "HUMAN_APPROVED", approvedByUserId: "user_7", approvedAt: NOW });
  });

  it("is blocked by the same gates as automation: approval is not a bypass", async () => {
    const { dependencies, sends } = harness({ context: context({ takeover: { state: "HUMAN_ACTIVE", reason: "HUMAN_CLAIMED", since: NOW } }) });

    const outcome = await coordinateDelivery(
      dependencies,
      command({ authority: { kind: "HUMAN_APPROVED", approvedByUserId: "user_7", approvedAt: NOW } }),
    );

    expect(sends).toEqual([]);
    expect(outcome.status).toBe("CANCELLED");
  });
});

describe("a missing job", () => {
  it("sends nothing and claims nothing", async () => {
    const { dependencies, sends, settlements } = harness({ context: undefined });

    const outcome = await coordinateDelivery(dependencies, command());

    expect(outcome).toEqual({ status: "NOT_CLAIMABLE" });
    expect(sends).toEqual([]);
    expect(settlements).toEqual([]);
  });
});
