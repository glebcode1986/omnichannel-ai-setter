import { toUserId, type Actor, type ReasonCode, type SendAuthority } from "@omnichannel/domain";
import type { SendResult } from "@omnichannel/channel-core";
import { describe, expect, it } from "vitest";

import { coordinateDelivery, type DeliveryCommand, type DeliveryDependencies } from "./coordinate-delivery";
import type { ClaimOutcome, DeliveryChannelState, DeliverySendContext, DeliverySettlement, DeliveryStateGuard } from "./ports";
import type { PolicyLimits } from "../policy/inputs";

const NOW = new Date("2026-09-18T12:00:00.000Z");

/**
 * A guard is opaque to the coordinator, so a label standing in for one is enough — and it is what lets a
 * test prove *which* read a claim was made against, which is the whole question here.
 */
const guard = (label: string): DeliveryStateGuard => ({ label }) as unknown as DeliveryStateGuard;

const limits: PolicyLimits = {
  confidenceThreshold: 0.8,
  mandatoryReviewReasons: ["MISSING_FACT"],
  afterWindow: { channel: "INSTAGRAM", policy: "STANDARD_ONLY" },
};

const channelState: DeliveryChannelState = {
  window: { state: "OPEN_FREEFORM", expiresAt: new Date(NOW.getTime() + 3_600_000) },
  humanAgent: { state: "UNAVAILABLE", reason: "NOT_APPROVED" },
};

const context = (overrides: Partial<DeliverySendContext> = {}): DeliverySendContext => ({
  deliveryJobId: "djob_1",
  operationId: "op_1",
  workspaceId: "ws_1",
  commercial: { paidWorkAllowed: true, aiDrafts: true, autopilot: true },
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
  limits,
  authority: { kind: "AUTOMATED" },
  guard: guard("read_1"),
  ...overrides,
});

const APPROVER = { kind: "USER", userId: toUserId("11111111-1111-4111-8111-111111111111") } as const;

/** A delivery a person approved, as the review queue records it. */
const approved = (overrides: Partial<Extract<SendAuthority, { kind: "HUMAN_APPROVED" }>> = {}): SendAuthority => ({
  kind: "HUMAN_APPROVED",
  approvedByUserId: APPROVER.userId,
  approvedAt: NOW,
  reviewMode: "NORMAL",
  ...overrides,
});

/** The ownership approving a reply creates: the approver now holds the conversation. */
const ownedByApprover = (actor: Actor = APPROVER): DeliverySendContext["takeover"] => ({
  state: "HUMAN_ACTIVE",
  reason: "HUMAN_SENT_FROM_INBOX",
  since: NOW,
  actor,
});

const command = (overrides: Partial<DeliveryCommand> = {}): DeliveryCommand => ({
  operationId: "op_1",
  correlationId: "corr_1",
  ...overrides,
});

interface HarnessOptions {
  readonly context?: DeliverySendContext | undefined;
  /** The live channel facts this run should derive from whatever context it read. */
  readonly channelState?: DeliveryChannelState;
  readonly result?: SendResult;
  readonly claim?: ClaimOutcome;
  readonly maxAttempts?: number;
  /** How far the clock moves between reads; 0 (the default) keeps it fixed. */
  readonly clockStepMs?: number;
  /**
   * What each successive read returns, standing in for a conversation that changes while it is being
   * judged. The last entry is reused once the list runs out.
   */
  readonly reads?: readonly (DeliverySendContext | undefined)[];
  /** What each successive claim answers; the last entry is reused once the list runs out. */
  readonly claims?: readonly ClaimOutcome[];
}

function harness(options: HarnessOptions = {}) {
  const settlements: DeliverySettlement[] = [];
  const sends: { operationId: string; text: string }[] = [];
  const rescheduled: Date[] = [];
  const logs: string[] = [];
  let claims = 0;
  let reads = 0;
  let loads = 0;

  const claimedAgainst: (DeliveryStateGuard | undefined)[] = [];

  const dependencies: DeliveryDependencies = {
    store: {
      loadForSend: () => {
        loads += 1;
        if (options.reads !== undefined) {
          return Promise.resolve(options.reads[Math.min(loads, options.reads.length) - 1]);
        }
        return Promise.resolve("context" in options ? options.context : context());
      },
      claim: (claimed) => {
        claims += 1;
        claimedAgainst.push(claimed.guard);
        if (options.claims !== undefined) {
          return Promise.resolve(options.claims[Math.min(claims, options.claims.length) - 1] ?? { kind: "NOT_CLAIMABLE", status: "SENDING" });
        }
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
    channel: { stateFor: () => options.channelState ?? channelState },
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
    // Advances by a fixed step on every read when a test asks for it. Nothing in production reads the
    // clock twice expecting the same answer, and the deferral guard exists precisely because time passes
    // between judging a reply and acting on the judgement.
    now: () => {
      const at = new Date(NOW.getTime() + reads * (options.clockStepMs ?? 0));
      reads += 1;
      return at;
    },
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
  };
  return { dependencies, settlements, sends, rescheduled, logs, claimedAgainst };
}

describe("the happy path is the only path to a send", () => {
  it("re-reads, re-judges, claims and sends exactly once", async () => {
    const { dependencies, sends, settlements } = harness();

    const outcome = await coordinateDelivery(dependencies, command());

    expect(outcome).toMatchObject({ status: "SENT", platformMessageId: "mid_1" });
    // The raw result travels with the outcome, so the queue layer can run its own disposition logic.
    expect(outcome.status === "SENT" ? outcome.sendResult : undefined).toEqual({ outcome: "ACCEPTED", platformMessageId: "mid_1" });
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

describe("the state moving between the judgement and the claim", () => {
  it("claims against the state it judged, not merely against the operation", async () => {
    const { dependencies, claimedAgainst } = harness();

    await coordinateDelivery(dependencies, command());

    // Without this, the claim is conditional on a row and not on the approval, and every test below
    // describes something the database would have allowed.
    expect(claimedAgainst).toEqual([guard("read_1")]);
  });

  it("sends nothing when a customer message lands in the gap, and cancels on what replaced the approval", async () => {
    const { dependencies, sends, settlements, logs } = harness({
      // The first read is a perfectly valid state. Between it and the claim the customer writes again, so
      // the claim is refused and the second read is what actually decides.
      reads: [context(), context({ replyCycle: "SUPERSEDED", guard: guard("read_2") })],
      claims: [{ kind: "STATE_CHANGED" }, { kind: "CLAIMED" }],
    });

    const outcome = await coordinateDelivery(dependencies, command());

    expect(sends).toEqual([]);
    expect(outcome).toMatchObject({ status: "CANCELLED", reasons: ["SUPERSEDED_BY_NEWER_INBOUND"] });
    expect(settlements).toEqual([{ kind: "CANCELLED", status: "CANCELLED_SUPERSEDED", reasons: ["SUPERSEDED_BY_NEWER_INBOUND"] }]);
    expect(logs).toContain("delivery.state_changed");
  });

  it("sends nothing when a colleague takes the conversation over in the gap", async () => {
    const { dependencies, sends, settlements } = harness({
      reads: [
        context(),
        context({ takeover: { state: "HUMAN_ACTIVE", reason: "HUMAN_SENT_FROM_INBOX", since: NOW }, guard: guard("read_2") }),
      ],
      claims: [{ kind: "STATE_CHANGED" }, { kind: "CLAIMED" }],
    });

    const outcome = await coordinateDelivery(dependencies, command());

    expect(sends).toEqual([]);
    expect(outcome.status).toBe("CANCELLED");
    expect(settlements).toEqual([{ kind: "CANCELLED", status: "CANCELLED_HUMAN_TAKEOVER", reasons: ["HUMAN_TAKEOVER"] }]);
  });

  it("re-claims against the state it re-read, never against the one that was overtaken", async () => {
    const { dependencies, sends, claimedAgainst } = harness({
      // The change was benign — something moved that the gates do not care about — so the send still goes.
      reads: [context(), context({ guard: guard("read_2") })],
      claims: [{ kind: "STATE_CHANGED" }, { kind: "CLAIMED" }],
    });

    await coordinateDelivery(dependencies, command());

    expect(claimedAgainst).toEqual([guard("read_1"), guard("read_2")]);
    expect(sends).toHaveLength(1);
  });

  it("hands the job back to the queue rather than guessing when the state keeps moving", async () => {
    const { dependencies, sends, rescheduled, settlements } = harness({
      // A conversation being actively written in. Each read is valid and each claim is overtaken.
      claims: [{ kind: "STATE_CHANGED" }],
    });

    const outcome = await coordinateDelivery(dependencies, command());

    // Nothing sent, nothing settled: this call simply could not establish that the approval still held.
    expect(sends).toEqual([]);
    expect(settlements).toEqual([]);
    expect(rescheduled).toEqual([NOW]);
    expect(outcome).toEqual({ status: "RESCHEDULED", notBefore: NOW });
  });

  it("stops when the delivery disappears between the refused claim and the re-read", async () => {
    const { dependencies, sends } = harness({
      reads: [context(), undefined],
      claims: [{ kind: "STATE_CHANGED" }],
    });

    const outcome = await coordinateDelivery(dependencies, command());

    expect(outcome).toEqual({ status: "NOT_CLAIMABLE" });
    expect(sends).toEqual([]);
  });

  it("keeps telling a lost race apart from an overtaken one", async () => {
    const { dependencies, sends, rescheduled } = harness({ claims: [{ kind: "NOT_CLAIMABLE", status: "SENDING" }] });

    const outcome = await coordinateDelivery(dependencies, command());

    // Another worker owning the send is final; it must not be re-read and retried like a moved state.
    expect(outcome).toEqual({ status: "NOT_CLAIMABLE" });
    expect(sends).toEqual([]);
    expect(rescheduled).toEqual([]);
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
    const { dependencies, sends, settlements } = harness({
      channelState: { window: { state: "NOT_ELIGIBLE", reason: "closed" }, humanAgent: { state: "UNAVAILABLE", reason: "EXPIRED" } },
    });

    const outcome = await coordinateDelivery(dependencies, command());

    expect(sends).toEqual([]);
    expect(settlements[0]).toMatchObject({ kind: "CANCELLED", status: "CANCELLED_POLICY" });
    expect(outcome.status).toBe("CANCELLED");
  });

  it("refuses a draft a person was asked to look at, however good the rest of the state is", async () => {
    // The draft engine already decided this one needs a human. The coordinator does not re-judge that —
    // it carries the decision forward — but it must not lose it either: every other gate here passes, so
    // nothing else would stop the send.
    const { dependencies, sends, settlements } = harness({ context: { ...context(), draftNeedsReview: true } });

    await coordinateDelivery(dependencies, command());

    expect(sends).toEqual([]);
    expect(settlements[0]).toMatchObject({ kind: "HELD" });
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
    expect(outcome).toMatchObject({ status: "HELD", reason: "send outcome is unknown" });
    // Carried out so the queue can enqueue reconciliation; carried out is not the same as retried.
    expect(outcome.status === "HELD" ? outcome.sendResult?.outcome : undefined).toBe("AMBIGUOUS");
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

const quietHourLimits: PolicyLimits = { ...limits, mandatoryReviewReasons: [], quietHours: { timeZone: "UTC", start: "11:00", end: "14:00" } };
const openWindow: DeliveryChannelState = {
  window: { state: "OPEN_FREEFORM", expiresAt: new Date("2026-09-30T00:00:00.000Z") },
  humanAgent: { state: "UNAVAILABLE", reason: "NOT_APPROVED" },
};

describe("quiet hours that begin during the delay", () => {
  it("waits for the quiet period to end instead of sending or failing", async () => {
    const { dependencies, sends, rescheduled } = harness({ context: context({ limits: quietHourLimits }), channelState: openWindow });

    const outcome = await coordinateDelivery(dependencies, command());

    expect(sends).toEqual([]);
    expect(outcome).toMatchObject({ status: "RESCHEDULED" });
    expect(rescheduled[0]?.toISOString()).toBe("2026-09-18T14:00:00.000Z");
  });

  it("sends rather than rescheduling when the quiet period ended while it was being judged", async () => {
    // Ninety minutes pass between each read of the clock. The policy still sees a quiet period and picks
    // 14:00; by the time that choice is acted on it is 15:00 and the instant has gone. Rescheduling to a
    // moment in the past is a job that wakes immediately and does the same thing again — a reply that
    // never leaves, for a rule that no longer applies.
    const { dependencies, sends, rescheduled } = harness({
      clockStepMs: 90 * 60_000,
      context: context({ limits: quietHourLimits }),
      channelState: openWindow,
    });

    const outcome = await coordinateDelivery(dependencies, command());

    expect(rescheduled).toEqual([]);
    expect(sends).toHaveLength(1);
    expect(outcome).toMatchObject({ status: "SENT" });
  });

  it("holds rather than deferring when waiting would miss the provider's deadline", async () => {
    const { dependencies, sends, settlements, rescheduled } = harness({
      context: context({ limits: quietHourLimits }),
      channelState: { ...openWindow, dispatchDeadline: new Date(NOW.getTime() + 25_000) },
    });

    await coordinateDelivery(dependencies, command());

    expect(rescheduled).toEqual([]);
    expect(sends).toEqual([]);
    expect(settlements[0]).toMatchObject({ kind: "HELD", status: "HELD_REVIEW" });
  });
});

describe("the human-approved path", () => {
  it("carries the approving actor to the adapter and still re-checks eligibility first", async () => {
    const sends: { authority: unknown }[] = [];
    const { dependencies } = harness({ context: context({ takeover: ownedByApprover(), authority: approved() }) });
    const withCapture: DeliveryDependencies = {
      ...dependencies,
      sender: {
        send: (input) => {
          sends.push({ authority: input.authority });
          return Promise.resolve({ outcome: "ACCEPTED", platformMessageId: "mid_1" });
        },
      },
    };

    await coordinateDelivery(withCapture, command());

    // Carried across whole from the row the approval was recorded on: the adapter is told who authorized
    // this send, and this call had no way to say anything else.
    expect(sends[0]?.authority).toEqual(approved());
  });

  it("sends a reply a person approved even though the mode holds every automated one", async () => {
    // DRAFT mode plus the approver's own ownership: the two things that exist to make a human look, after
    // a human has looked. Under automation this is a hold; here it is the reply the person asked for.
    const { dependencies, sends, settlements } = harness({
      context: context({ mode: "DRAFT", takeover: ownedByApprover(), authority: approved() }),
    });

    const outcome = await coordinateDelivery(dependencies, command());

    expect(outcome).toMatchObject({ status: "SENT" });
    expect(sends).toHaveLength(1);
    expect(settlements).toEqual([{ kind: "SENT", platformMessageId: "mid_1" }]);
  });

  it("does not reach past a colleague who has taken the conversation since", async () => {
    const other: Actor = { kind: "USER", userId: toUserId("22222222-2222-4222-8222-222222222222") };
    const { dependencies, sends } = harness({ context: context({ takeover: ownedByApprover(other), authority: approved() }) });

    const outcome = await coordinateDelivery(dependencies, command());

    // They own the conversation now. An approval from before that is not authority over their work.
    expect(sends).toEqual([]);
    expect(outcome.status).toBe("CANCELLED");
  });

  it("is still stopped by everything an approval cannot answer", async () => {
    for (const [what, overrides] of [
      ["the customer wrote again", { replyCycle: "SUPERSEDED" as const }],
      ["automation was switched off entirely", { mode: "OFF" as const }],
      ["AI was disabled for the conversation", { aiEnabled: false }],
      ["the account stopped being usable", { account: "DISCONNECTED" as const }],
    ] satisfies readonly (readonly [string, Partial<DeliverySendContext>])[]) {
      const { dependencies, sends } = harness({ context: context({ ...overrides, takeover: ownedByApprover(), authority: approved() }) });

      const outcome = await coordinateDelivery(dependencies, command());

      // A click cannot reopen a window, unsay a customer's message or reconnect an account.
      expect(sends, what).toEqual([]);
      expect(outcome.status, what).not.toBe("SENT");
    }
  });

  it("uses the human-support path only when the person authorized that path and it is still live", async () => {
    const closed = { window: { state: "NOT_ELIGIBLE", reason: "closed" } as const, humanAgent: { state: "ELIGIBLE", expiresAt: new Date(NOW.getTime() + 60_000) } as const };
    const extended = { ...limits, afterWindow: { channel: "INSTAGRAM", policy: "HUMAN_ASSISTED_EXTENDED" } as const };

    const authorized = harness({
      channelState: closed,
      context: context({ limits: extended, takeover: ownedByApprover(), authority: approved({ reviewMode: "HUMAN_AGENT" }) }),
    });
    const sent = await coordinateDelivery(authorized.dependencies, command());
    expect(sent).toMatchObject({ status: "SENT" });
    expect(authorized.sends).toHaveLength(1);

    // The same closed window, approved as an ordinary reply. The only permitted route is the tagged send,
    // and nobody authorized one — so it goes back to a person rather than out on the standard path.
    const ordinary = harness({
      channelState: closed,
      context: context({ limits: extended, takeover: ownedByApprover(), authority: approved({ reviewMode: "NORMAL" }) }),
    });
    const held = await coordinateDelivery(ordinary.dependencies, command());
    expect(ordinary.sends).toEqual([]);
    expect(held.status).toBe("HELD");

    // And an authorization for the tagged path is worth nothing once the exception has lapsed.
    const lapsed = harness({
      channelState: { ...closed, humanAgent: { state: "ELIGIBLE", expiresAt: new Date(NOW.getTime() - 1) } },
      context: context({ limits: extended, takeover: ownedByApprover(), authority: approved({ reviewMode: "HUMAN_AGENT" }) }),
    });
    const expired = await coordinateDelivery(lapsed.dependencies, command());
    expect(lapsed.sends).toEqual([]);
    expect(expired.status).toBe("CANCELLED");
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
