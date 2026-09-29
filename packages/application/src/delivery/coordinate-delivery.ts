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
 * 2. **claim against what was judged** — the database picks one winner, and refuses a winner whose
 *    approval has been overtaken;
 * 3. **send once** — after the claim, and never again for that operation;
 * 4. **settle honestly** — an outcome that might have reached the platform is quarantined, never retried.
 *
 * Step 2 carries more weight than it looks. Re-reading and re-judging takes time, and a conversation does
 * not wait: the customer can write again, a colleague can take over, the business can switch automation off
 * — all *after* the read that approved the send and *before* the claim that takes it. A claim conditional
 * only on the delivery row would still succeed there and send on an approval that had already expired. So
 * the claim is bound to the state the approval rested on, and the database refuses both races in the same
 * statement: another worker holding the row, and the state having moved underneath this one.
 *
 * That binding can only reach as far as the claim. After it, the message is being handed to a provider and
 * nothing can recall it — which is the reason the binding belongs at the last possible instant rather than
 * anywhere earlier.
 *
 * Step 4 is the one that costs restraint. An ambiguous result is the case where retrying feels safe and is
 * not: the customer may already have the message, and a second one cannot be taken back (ADR-012).
 */
import { sendDisposition, type SendResult } from "@omnichannel/channel-core";
import type { ReasonCode } from "@omnichannel/domain";

import { evaluatePolicy } from "../policy/evaluate";
import type { PolicyInput } from "../policy/inputs";
import type {
  CancelledStatus,
  DeliveryChannelStatePort,
  DeliveryLogPort,
  DeliverySendContext,
  DeliverySendPort,
  DeliverySettlement,
  DeliveryStore,
} from "./ports";

export interface DeliveryDependencies {
  readonly store: DeliveryStore;
  readonly sender: DeliverySendPort;
  /** Derives the live channel facts from the state just read, so the window and the claim share an instant. */
  readonly channel: DeliveryChannelStatePort;
  readonly log: DeliveryLogPort;
  readonly now: () => Date;
  /** Bounded by the queue's own attempt policy; this is the coordinator's own ceiling on retryable sends. */
  readonly maxAttempts?: number;
}

export interface DeliveryCommand {
  readonly operationId: string;
  readonly correlationId: string;
  /**
   * Present when a kill switch covers this send (Issue #56); the policy engine decides what it means.
   *
   * The authority a send carries is deliberately *not* here: it is read from the delivery row inside the
   * same guarded read as everything else the decision rests on (#14), so a caller cannot construct one.
   */
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

/**
 * How many times one call may read, judge and try to claim.
 *
 * A refused claim means the state moved, so the next pass judges the state that replaced it — and usually
 * stops there, because what moved is normally the very thing that withdraws the approval. Two passes are
 * enough to tell "the conversation changed" from "this conversation changes constantly"; past that the job
 * goes back to the queue rather than this loop guessing again from a snapshot that is already old.
 */
const MAX_CLAIM_PASSES = 2;

export async function coordinateDelivery(dependencies: DeliveryDependencies, command: DeliveryCommand): Promise<DeliveryOutcome> {
  const fields = { operationId: command.operationId, correlationId: command.correlationId };
  let context = await dependencies.store.loadForSend(command.operationId);
  if (context === undefined) {
    // The job, draft or conversation is gone. Nothing to send and nothing to recover.
    dependencies.log.warn("delivery.missing", fields);
    return { status: "NOT_CLAIMABLE" };
  }

  for (let pass = 1; ; pass += 1) {
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

    // The context, not the id: the claim succeeds only while the state just judged is still the live one.
    const claim = await dependencies.store.claim(context, dependencies.now());
    if (claim.kind === "CLAIMED") {
      break;
    }
    if (claim.kind === "NOT_CLAIMABLE") {
      // The database refused. Another worker owns the send, or it already finished: either way, not ours.
      dependencies.log.info("delivery.not_claimable", { ...fields, status: claim.status });
      return { status: "NOT_CLAIMABLE" };
    }

    // The approval was overtaken. Nothing was claimed and nothing was sent, so the only question is what
    // the state that replaced it says — which the next pass asks, with the gates applied to it in full.
    dependencies.log.info("delivery.state_changed", { ...fields, pass });
    if (pass >= MAX_CLAIM_PASSES) {
      const notBefore = dependencies.now();
      await dependencies.store.reschedule(command.operationId, notBefore);
      dependencies.log.info("delivery.deferred", { ...fields, notBefore: notBefore.toISOString() });
      return { status: "RESCHEDULED", notBefore };
    }

    const reread = await dependencies.store.loadForSend(command.operationId);
    if (reread === undefined) {
      dependencies.log.warn("delivery.missing", fields);
      return { status: "NOT_CLAIMABLE" };
    }
    context = reread;
  }

  const result = await dependencies.sender.send({
    channel: context.channel,
    channelAccountId: context.channelAccountId,
    conversationId: context.conversationId,
    recipientExternalId: context.recipientExternalId,
    text: context.text ?? "",
    operationId: context.operationId,
    // The authority the approval was recorded with, carried across whole. The adapter is told who
    // authorized this send, and a queue job cannot tell it anything else.
    authority: context.authority,
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
  // Both from the read the claim will bind: the limits the store returned with the state, and the channel
  // facts derived from that same state. Nothing here was read at a different moment from anything else.
  const channelState = dependencies.channel.stateFor(context);
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
    limits: context.limits,
    account: context.account,
    capabilities: { text: true, image: false, video: false, audio: false, document: false, interactive: false, templates: false, reactions: false, readReceipts: false, typingIndicator: false },
    window: channelState.window,
    humanAgent: channelState.humanAgent,
    ...(channelState.dispatchDeadline === undefined ? {} : { dispatchDeadline: channelState.dispatchDeadline }),
    // The kill switch is the operator's, not the conversation's: it is a decision about this run rather
    // than a fact read with the state, so it stays on the command.
    ...(command.outboundSuspended === undefined ? {} : { outboundSuspended: command.outboundSuspended }),
    replyCycle: context.replyCycle,
    authority: context.authority,
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
