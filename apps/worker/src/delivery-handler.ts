/**
 * Worker composition of delivery.
 *
 * Everything decided here is plumbing. Whether the reply may still be sent is the coordinator's decision,
 * and whether it may ever be retried is the send result's — this file only supplies the live channel facts
 * the coordinator asks for and translates its outcome into the queue's vocabulary.
 *
 * One rule shapes the translation: **after a claim, this handler must not throw.** A thrown error is an
 * unknown outcome, and an unknown outcome is quarantined rather than retried (ADR-012). So the coordinator's
 * own settlement is always what reaches the database, and the queue is only ever told what already happened.
 */
import { coordinateDelivery, type DeliveryChannelState, type DeliveryCommand, type DeliveryDependencies, type PolicyLimits } from "@omnichannel/application";
import type { Logger } from "@omnichannel/observability";
import type { DeliveryAttemptResult, DeliveryJob } from "@omnichannel/queue";

export interface DeliveryHandlerDependencies {
  readonly engine: DeliveryDependencies;
  /** Resolves the automation limits and the live channel state for one conversation, at send time. */
  readonly conversationPolicy: (job: DeliveryJob) => Promise<
    | {
        readonly limits: PolicyLimits;
        readonly channelState: DeliveryChannelState;
        /** Present when a kill switch covers this send; carried straight through to the policy engine. */
        readonly outboundSuspended?: DeliveryCommand["outboundSuspended"];
      }
    | undefined
  >;
  readonly logger: Logger;
}

export function createDeliveryHandler(dependencies: DeliveryHandlerDependencies) {
  return async function deliver(job: DeliveryJob): Promise<DeliveryAttemptResult> {
    const policy = await dependencies.conversationPolicy(job);
    if (policy === undefined) {
      // No conversation, no policy, nothing to send. Retrying cannot conjure one.
      return { status: "NOT_CLAIMED", retryable: false, reason: "the conversation is no longer deliverable" };
    }

    const outcome = await coordinateDelivery(dependencies.engine, {
      operationId: job.operationId,
      correlationId: job.correlationId,
      limits: policy.limits,
      channelState: policy.channelState,
      ...(policy.outboundSuspended === undefined ? {} : { outboundSuspended: policy.outboundSuspended }),
      // A queue job is automation by construction: there is no acting human to name here, and the type
      // makes claiming one impossible rather than merely wrong.
      authority: { kind: "AUTOMATED" },
    });

    dependencies.logger.info("worker.delivery", {
      correlationId: job.correlationId,
      operationId: job.operationId,
      outcome: outcome.status,
    });

    // The adapter was called exactly when a send result came back, and only then may the queue layer run
    // its own disposition logic — including enqueueing reconciliation for an ambiguous outcome.
    switch (outcome.status) {
      case "SENT":
      case "RETRY":
        return { status: "SEND_RESULT", result: outcome.sendResult };
      case "HELD":
        return outcome.sendResult === undefined
          ? { status: "NOT_CLAIMED", retryable: false, reason: outcome.reason }
          : { status: "SEND_RESULT", result: outcome.sendResult };
      case "RESCHEDULED":
        // Already moved to a later time in the database; this attempt is simply over.
        return { status: "SKIPPED", reason: `deferred until ${outcome.notBefore.toISOString()}` };
      case "CANCELLED":
        return { status: "SKIPPED", reason: outcome.reasons.join(",") };
      case "NOT_CLAIMABLE":
        return { status: "NOT_CLAIMED", retryable: false, reason: "another worker owns this delivery, or it is already finished" };
    }
  };
}
