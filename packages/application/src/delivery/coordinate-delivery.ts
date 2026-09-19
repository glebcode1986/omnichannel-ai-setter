/**
 * The delivery coordinator (DELIVERY_COORDINATOR.md, ADR-003, ADR-012, ADR-014).
 *
 * One reply, one send attempt, decided at the last possible moment. The delay between drafting and sending
 * is where a conversation changes: the customer writes again, a colleague picks it up, the window closes,
 * the business switches off automation. So nothing decided at scheduling time is trusted here — the whole
 * state is re-read and re-judged by the same policy engine that approved the draft, and only then is the
 * send claimed.
 *
 * The ordering is deliberate and is the safety argument:
 *
 * 1. **re-read, then re-judge** — a stale approval is not an approval;
 * 2. **claim atomically** — the database picks one winner, so two workers cannot both send;
 * 3. **send once** — after the claim, and never again for that operation;
 * 4. **settle honestly** — an outcome that might have reached the platform is quarantined, never retried.
 *
 * Step 4 is the one that costs restraint. An ambiguous result is the case where retrying feels safe and is
 * not: the customer may already have the message, and a second one cannot be taken back (ADR-012).
 */
import { sendDisposition, type SendResult } from "@omnichannel/channel-core";
import type { ReasonCode } from "@omnichannel/domain";

import { evaluatePolicy } from "../policy/evaluate";
import type { PolicyInput, PolicyLimits } from "../policy/inputs";
import type {
  CancelledStatus,
  DeliveryAuthority,
  DeliveryChannelState,
  DeliveryLogPort,
  DeliverySendContext,
  DeliverySendPort,
  DeliverySettlement,
  DeliveryStore,
} from "./ports";

export interface DeliveryDependencies {
  readonly store: DeliveryStore;
  readonly sender: DeliverySendPort;
  readonly log: DeliveryLogPort;
  readonly now: () => Date;
  /** Bounded by the queue's own attempt policy; this is the coordinator's own ceiling on retryable sends. */
  readonly maxAttempts?: number;
}

export interface DeliveryCommand {
  readonly operationId: string;
  readonly correlationId: string;
  readonly limits: PolicyLimits;
  readonly channelState: DeliveryChannelState;
  readonly authority: DeliveryAuthority;
  /** Present when a kill switch covers this send (Issue #56); the policy engine decides what it means. */
  readonly outboundSuspended?: PolicyInput["outboundSuspended"];
}

/**
 * `sendResult` is present exactly when the adapter was actually called. Its absence is meaningful: it says
 * the reply never left this process, which is what lets a caller tell "we decided not to" from "we tried".
 */
export type DeliveryOutcome =
  | { readonly status: "SENT"; readonly platformMessageId: string; readonly sendResult: SendResult }
  | { readonly status: "CANCELLED"; readonly reasons: readonly ReasonCode[] }
  | { readonly status: "HELD"; readonly reason: string; readonly sendResult?: SendResult }
  | { readonly status: "RESCHEDULED"; readonly notBefore: Date }
  /** Another worker owns it, or it is already finished. Nothing was sent by this call. */
  | { readonly status: "NOT_CLAIMABLE" }
  /** A retryable provider rejection; the queue may try again while the state still allows it. */
  | { readonly status: "RETRY"; readonly reason: string; readonly sendResult: SendResult };

const DEFAULT_MAX_ATTEMPTS = 3;

export async function coordinateDelivery(dependencies: DeliveryDependencies, command: DeliveryCommand): Promise<DeliveryOutcome> {
  const fields = { operationId: command.operationId, correlationId: command.correlationId };
  const context = await dependencies.store.loadForSend(command.operationId);
  if (context === undefined) {
    // The job, draft or conversation is gone. Nothing to send and nothing to recover.
    dependencies.log.warn("delivery.missing", fields);
    return { status: "NOT_CLAIMABLE" };
  }

  const preflight = revalidate(dependencies, command, context);
  if (preflight !== undefined) {
    // Settled without claiming: a gate that fails here must never reach the adapter at all.
    await dependencies.store.settle(command.operationId, preflight.settlement, dependencies.now());
    dependencies.log.info("delivery.blocked", { ...fields, settlement: preflight.settlement.kind, reasons: preflight.reasons });
    return preflight.outcome;
  }

  const deferral = deferralFor(dependencies, command, context);
  if (deferral !== undefined) {
    await dependencies.store.reschedule(command.operationId, deferral);
    dependencies.log.info("delivery.deferred", { ...fields, notBefore: deferral.toISOString() });
    return { status: "RESCHEDULED", notBefore: deferral };
  }

  const claim = await dependencies.store.claim(command.operationId, dependencies.now());
  if (claim.kind !== "CLAIMED") {
    // The database refused. Another worker owns the send, or it already finished: either way, not ours.
    dependencies.log.info("delivery.not_claimable", { ...fields, status: claim.status });
    return { status: "NOT_CLAIMABLE" };
  }

  const result = await dependencies.sender.send({
    channel: context.channel,
    channelAccountId: context.channelAccountId,
    conversationId: context.conversationId,
    recipientExternalId: context.recipientExternalId,
    text: context.text ?? "",
    operationId: context.operationId,
    authority: command.authority,
  });

  switch (sendDisposition(result)) {
    case "COMPLETED": {
      const accepted = result.outcome === "ACCEPTED" ? result : undefined;
      const settlement: DeliverySettlement = {
        kind: "SENT",
        platformMessageId: accepted?.platformMessageId ?? "",
        ...(accepted?.providerRequestId === undefined ? {} : { providerRequestId: accepted.providerRequestId }),
      };
      await dependencies.store.settle(command.operationId, settlement, dependencies.now());
      dependencies.log.info("delivery.sent", { ...fields, platformMessageId: settlement.platformMessageId });
      return { status: "SENT", platformMessageId: settlement.platformMessageId, sendResult: result };
    }
    case "RETRY_ALLOWED": {
      const rejected = result.outcome === "REJECTED" ? result : undefined;
      const message = rejected?.message ?? "retryable rejection";
      // The coordinator keeps its own ceiling: a queue whose attempt policy changes must not turn a
      // bounded retry into an unbounded one.
      const exhausted = context.attemptCount + 1 >= (dependencies.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
      const settlement: DeliverySettlement = exhausted
        ? { kind: "EXHAUSTED", ...(rejected?.code === undefined ? {} : { code: rejected.code }), message }
        : { kind: "RETRY", ...(rejected?.code === undefined ? {} : { code: rejected.code }), message };
      await dependencies.store.settle(command.operationId, settlement, dependencies.now());
      dependencies.log.warn("delivery.rejected_retryable", { ...fields, code: rejected?.code, exhausted });
      return exhausted
        ? { status: "HELD", reason: "retry attempts exhausted", sendResult: result }
        : { status: "RETRY", reason: message, sendResult: result };
    }
    case "FAILED": {
      const rejected = result.outcome === "REJECTED" ? result : undefined;
      await dependencies.store.settle(
        command.operationId,
        {
          kind: "HELD",
          status: "HELD_REVIEW",
          ...(rejected?.code === undefined ? {} : { code: rejected.code }),
          message: rejected?.message ?? "provider rejected the send",
        },
        dependencies.now(),
      );
      dependencies.log.warn("delivery.rejected", { ...fields, code: rejected?.code });
      return { status: "HELD", reason: rejected?.message ?? "provider rejected the send", sendResult: result };
    }
    case "QUARANTINE_NO_RETRY": {
      const ambiguous = result.outcome === "AMBIGUOUS" ? result : undefined;
      // The request may have reached the platform. A second attempt could put two replies in front of the
      // customer, and nothing can take the first one back — so this is where automation stops (ADR-012).
      await dependencies.store.settle(
        command.operationId,
        {
          kind: "HELD",
          status: "HELD_AMBIGUOUS",
          ...(ambiguous?.code === undefined ? {} : { code: ambiguous.code }),
          message: ambiguous?.message ?? "send outcome is unknown",
        },
        dependencies.now(),
      );
      dependencies.log.error("delivery.ambiguous", { ...fields, code: ambiguous?.code });
      return { status: "HELD", reason: "send outcome is unknown", sendResult: result };
    }
  }
}

/**
 * The final gate, run before anything is claimed.
 *
 * It asks the policy engine rather than re-implementing the rules: one place decides whether a reply may be
 * sent automatically, and a second copy of that logic here would drift from it — quietly, and in the
 * direction of sending.
 */
function revalidate(
  dependencies: DeliveryDependencies,
  command: DeliveryCommand,
  context: DeliverySendContext,
): { readonly settlement: DeliverySettlement; readonly outcome: DeliveryOutcome; readonly reasons: readonly ReasonCode[] } | undefined {
  if (context.alreadySent || context.status === "SENT") {
    // Idempotency, not a gate: the logical action already happened, and repeating it is the one mistake
    // this whole module exists to avoid.
    return {
      settlement: { kind: "HELD", status: "HELD_REVIEW", message: "the delivery already completed" },
      outcome: { status: "NOT_CLAIMABLE" },
      reasons: [],
    };
  }
  if (context.text === undefined || context.text.trim() === "") {
    return {
      settlement: { kind: "HELD", status: "HELD_REVIEW", message: "the draft has no sendable text" },
      outcome: { status: "HELD", reason: "the draft has no sendable text" },
      reasons: [],
    };
  }

  const decision = evaluatePolicy(policyInputFor(dependencies, command, context));
  if (decision.action === "SCHEDULE") {
    return undefined;
  }
  if (decision.action === "HOLD_REVIEW") {
    return {
      settlement: { kind: "HELD", status: "HELD_REVIEW", message: decision.reasons.join(",") },
      outcome: { status: "HELD", reason: decision.reasons.join(",") },
      reasons: decision.reasons,
    };
  }
  const status = cancelledStatusFor(decision.reasons);
  return {
    settlement: { kind: "CANCELLED", status, reasons: decision.reasons },
    outcome: { status: "CANCELLED", reasons: decision.reasons },
    reasons: decision.reasons,
  };
}

/**
 * A `SCHEDULE` whose `notBefore` is still ahead means quiet hours began during the delay. Sending now would
 * ignore the business's own setting; failing would waste a perfectly good draft. It waits instead.
 */
function deferralFor(dependencies: DeliveryDependencies, command: DeliveryCommand, context: DeliverySendContext): Date | undefined {
  const decision = evaluatePolicy(policyInputFor(dependencies, command, context));
  if (decision.action !== "SCHEDULE" || decision.notBefore === undefined) {
    return undefined;
  }
  return decision.notBefore.getTime() > dependencies.now().getTime() ? decision.notBefore : undefined;
}

function policyInputFor(dependencies: DeliveryDependencies, command: DeliveryCommand, context: DeliverySendContext): PolicyInput {
  return {
    mode: context.mode,
    aiEnabled: context.aiEnabled,
    takeover: context.takeover,
    draft: {
      // The draft is already written and validated; what matters now is whether it may still go out.
      usable: context.text !== undefined,
      // Confidence and categories were judged when the draft was approved. Re-judging them here would
      // re-litigate a decision, not revalidate a state, so this gate carries the approval forward and lets
      // the *state* gates do the work.
      confidence: context.draftNeedsReview ? 0 : 1,
      reasonCodes: [],
      citedSourceIds: [],
      contentType: "TEXT",
    },
    retrieval: { suppliedSourceIds: [], corpusReachable: true },
    limits: command.limits,
    account: context.account,
    capabilities: { text: true, image: false, video: false, audio: false, document: false, interactive: false, templates: false, reactions: false, readReceipts: false, typingIndicator: false },
    window: command.channelState.window,
    humanAgent: command.channelState.humanAgent,
    ...(command.channelState.dispatchDeadline === undefined ? {} : { dispatchDeadline: command.channelState.dispatchDeadline }),
    ...(command.outboundSuspended === undefined ? {} : { outboundSuspended: command.outboundSuspended }),
    replyCycle: context.replyCycle,
    now: dependencies.now(),
  };
}

/** The most specific cause wins, so the audit trail says what actually stopped the send. */
function cancelledStatusFor(reasons: readonly ReasonCode[]): CancelledStatus {
  if (reasons.includes("SUPERSEDED_BY_NEWER_INBOUND")) {
    return "CANCELLED_SUPERSEDED";
  }
  return reasons.includes("HUMAN_TAKEOVER") ? "CANCELLED_HUMAN_TAKEOVER" : "CANCELLED_POLICY";
}
