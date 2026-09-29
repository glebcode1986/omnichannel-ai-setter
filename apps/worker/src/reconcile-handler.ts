/**
 * The reconciliation processor (ADR-012, Issue #56).
 *
 * Composition only: the decision lives in `reconcileOperation`, and everything this file adds is the two
 * things a pure function cannot do — put a resumed operation back on the delivery queue, and ask to be
 * called again when the answer is still unknown.
 *
 * Asking again is a throw rather than a re-enqueue. A reconciliation job's id is derived from the
 * operation, so re-enqueueing from inside its own run would collide with the job that is running and be
 * silently dropped; throwing hands the retry to BullMQ's own backoff, which is what the family was
 * configured with. When those attempts run out the durable record is still `PENDING`, and the sweeper
 * raises it again — the queue is a convenience here, never the system of record.
 */
import { reconcileOperation, type ReconcileDependencies } from "@omnichannel/application";
import type { Logger } from "@omnichannel/observability";
import type { QueueProducer, ReconciliationJob } from "@omnichannel/queue";

export interface ReconcileHandlerDependencies {
  readonly engine: ReconcileDependencies;
  /** Re-reads the delivery job and re-enqueues it, so the coordinator decides everything again. */
  readonly resumeDelivery: (operationId: string) => Promise<void>;
  readonly logger: Logger;
}

/** Thrown to ask BullMQ for another attempt; it carries no outcome and never reaches a customer. */
export class ReconciliationUnresolvedError extends Error {
  constructor(operationId: string, detail: string) {
    super(`delivery ${operationId} is still unresolved: ${detail}`);
    this.name = "ReconciliationUnresolvedError";
  }
}

export function createReconcileHandler(dependencies: ReconcileHandlerDependencies) {
  return async function reconcile(job: ReconciliationJob): Promise<void> {
    const outcome = await reconcileOperation(dependencies.engine, {
      workspaceId: job.workspaceId,
      businessProfileId: job.businessProfileId,
      operationId: job.operationId,
      deliveryJobId: job.deliveryJobId,
      conversationId: job.conversationId,
      reason: job.reason,
      detectedAt: new Date(job.detectedAt),
      ...(job.providerRequestId === undefined ? {} : { providerRequestId: job.providerRequestId }),
      ...(job.providerCode === undefined ? {} : { providerCode: job.providerCode }),
    });

    if (outcome.state === "RESOLVED_RESUMED") {
      // The store has already returned the job to the claimable state; this only puts it back in front of
      // the coordinator, which will re-read the conversation and may well decide not to send at all.
      await dependencies.resumeDelivery(job.operationId);
    }

    dependencies.logger.info("worker.reconciled", {
      operationId: job.operationId,
      state: outcome.state,
      reason: job.reason,
    });

    if (outcome.retryLater) {
      throw new ReconciliationUnresolvedError(job.operationId, outcome.evidence);
    }
  };
}

/**
 * Puts a resumed operation back on the delivery queue.
 *
 * Deliberately re-reads the delivery row instead of reusing the original job payload: the payload was
 * written before the outage, and the schedule, the draft and the conversation may all have moved since.
 */
export function createDeliveryResumer(
  load: (operationId: string) => Promise<ReconciliationDeliveryFacts | undefined>,
  producer: QueueProducer,
  logger: Logger,
) {
  return async function resumeDelivery(operationId: string): Promise<void> {
    const facts = await load(operationId);
    if (facts === undefined) {
      logger.warn("worker.resume_without_job", { operationId });
      return;
    }
    await producer.scheduleDelivery(
      {
        schemaVersion: 1,
        workspaceId: facts.workspaceId,
        businessProfileId: facts.businessProfileId,
        correlationId: facts.correlationId,
        conversationId: facts.conversationId,
        deliveryJobId: facts.deliveryJobId,
        draftId: facts.draftId,
        operationId,
        scheduledFor: facts.scheduledFor.toISOString(),
        // The delay is history now — the operation is being resumed, not scheduled — but the payload
        // records what was originally chosen so an audit of the send still reads correctly.
        selectedDelayMs: facts.selectedDelayMs,
      },
      // The delivery job that failed unrecoverably is retained under this same identity, and a retained
      // identity makes an enqueue a silent no-op. Without this the operation would be resumed in the
      // database and then never delivered — recovery that looks like it worked and did not.
      { replaceRetained: true },
    );
  };
}

export interface ReconciliationDeliveryFacts {
  readonly workspaceId: string;
  readonly businessProfileId: string;
  readonly correlationId: string;
  readonly conversationId: string;
  readonly deliveryJobId: string;
  readonly draftId: string;
  readonly scheduledFor: Date;
  readonly selectedDelayMs: number;
}
