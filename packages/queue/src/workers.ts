import { parseSendResult, sendDisposition, type SendDisposition, type SendResult } from "@omnichannel/channel-core";
import type { ReconciliationReason } from "@omnichannel/domain";
import type { Logger } from "@omnichannel/observability";
import { UnrecoverableError, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";

import {
  AI_DRAFT_GENERATION,
  DEFAULT_QUEUE_PREFIX,
  DELIVERY,
  DEFAULT_QUEUE_LIMITS,
  INBOUND_DEBOUNCE,
  RECONCILIATION,
  type JobFamily,
  type QueueExecutionLimits,
} from "./families";
import {
  JobPayloadValidationError,
  parsePayload,
  type AiDraftGenerationJob,
  type DeliveryJob,
  type InboundDebounceJob,
  type ReconciliationJob,
} from "./payloads";
import { closeAll } from "./close-all";
import { createQueueProducer } from "./producer";
import { createReplyCycleRegistry, type ReplyCycleOwnership } from "./reply-cycle";

export interface JobContext {
  readonly jobId: string;
  /** 1-based attempt number of this run. */
  readonly attempt: number;
  /** Logger bound to queue, job, workspace, Business Profile and correlation identifiers. */
  readonly logger: Logger;
}

/** What a delivery handler (the future delivery coordinator) reports back to the queue layer. */
export type DeliveryAttemptResult =
  /** The coordinator claimed the operation and called the adapter. */
  | { readonly status: "SEND_RESULT"; readonly result: SendResult }
  /** The job no longer owns the send (superseded, cancelled, human takeover, policy); nothing was sent. */
  | { readonly status: "SKIPPED"; readonly reason: string }
  /** The operation was not claimed, so nothing was sent; `retryable` allows a queue retry. */
  | { readonly status: "NOT_CLAIMED"; readonly retryable: boolean; readonly reason: string };

export interface QueueHandlers {
  /** Called only while the job's anchor still owns the reply cycle (or ownership is untracked). */
  onInboundDebounceElapsed(
    job: InboundDebounceJob,
    context: JobContext & { readonly replyCycle: Exclude<ReplyCycleOwnership, "SUPERSEDED"> },
  ): Promise<void>;
  generateAiDraft(job: AiDraftGenerationJob, context: JobContext): Promise<void>;
  /**
   * Must claim the operation before sending and must not throw after a send may have happened; a thrown
   * error is treated as an unknown outcome and quarantined for reconciliation, never retried.
   */
  deliver(job: DeliveryJob, context: JobContext): Promise<DeliveryAttemptResult>;
  /** Placeholder until reconciliation is implemented; it can never send. */
  reconcile(job: ReconciliationJob, context: JobContext): Promise<void>;
}

/** Thrown by a handler to fail a job without retries. */
export class NonRetryableJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableJobError";
  }
}

export type JobOutcome =
  | "HANDLED"
  | "SUPERSEDED"
  | "SENT"
  | "SKIPPED"
  | "NOT_CLAIMED"
  | "REJECTED"
  | "QUARANTINED";

export interface QueueWorkersOptions {
  /**
   * Connection (created with role "worker") used for reply-cycle checks and reconciliation enqueues; each
   * BullMQ worker opens its own connections with the same options. Owned by the caller.
   */
  readonly connection: Redis;
  readonly logger: Logger;
  readonly handlers: QueueHandlers;
  readonly prefix?: string;
  /** Fallback for a queue with no entry in `limits`; kept for callers that only need one number. */
  readonly concurrency?: number;
  /**
   * Per-queue concurrency and rate limits. Defaults to `DEFAULT_QUEUE_LIMITS`, which is where the
   * reasoning for each number lives; pass a partial map to override individual queues.
   */
  readonly limits?: Readonly<Record<string, QueueExecutionLimits>>;
  /** Lock/stall timings; production uses BullMQ defaults (30 s), tests shorten them. */
  readonly lockDurationMs?: number;
  readonly stalledIntervalMs?: number;
  readonly now?: () => Date;
  /**
   * Called for every job failure, so the process can fold many failures into one incident (Issue #56).
   *
   * Deliberately synchronous and total: it runs on the failure path, and a reporter that could throw or
   * hang there would turn one bad dependency into a worker that stops taking jobs. The queue does no
   * aggregation itself — it only reports what failed, and something above decides what that means.
   */
  readonly onJobFailure?: (failure: JobFailure) => void;
}

export interface JobFailure {
  readonly queueName: string;
  readonly workspaceId: string;
  readonly businessProfileId: string;
  /** The conversation this job was acting on, when the payload names one. Blast radius, not identity. */
  readonly conversationId?: string;
  /** The error's class name. Never its message, which routinely carries hosts, URLs and keys. */
  readonly errorName: string;
  readonly willRetry: boolean;
}

export interface QueueWorkers {
  readonly queueNames: readonly string[];
  /**
   * Graceful by default: stops taking jobs and waits for running jobs to finish. `force` stops without
   * waiting (shutdown timeout); an interrupted delivery then stalls and is failed, never re-run.
   */
  close(options?: { readonly force?: boolean }): Promise<void>;
}

const STALLED_FAILURE = "job stalled more than allowable limit";
/** How long close waits for a first connection attempt before giving up on it. A bound, not a guess. */
const CONNECTION_SETTLE_TIMEOUT_MS = 2_000;

export function createQueueWorkers(options: QueueWorkersOptions): QueueWorkers {
  const prefix = options.prefix ?? DEFAULT_QUEUE_PREFIX;
  const now = options.now ?? (() => new Date());
  const { handlers, logger } = options;
  const replyCycles = createReplyCycleRegistry(options.connection, prefix);
  const reconciliation = createQueueProducer({ connection: options.connection, logger, prefix, now });

  /** Never lets a reporter's own failure reach the job: the job already failed for its own reasons. */
  const reportFailure = (failure: JobFailure): void => {
    try {
      options.onJobFailure?.(failure);
    } catch (error) {
      logger.warn("queue.failure_report_failed", { errorName: errorName(error) });
    }
  };

  async function quarantine(
    job: DeliveryJob,
    reason: ReconciliationReason,
    jobLogger: Logger,
    result?: SendResult,
  ): Promise<void> {
    try {
      await reconciliation.enqueueReconciliation({
        schemaVersion: 1,
        workspaceId: job.workspaceId,
        businessProfileId: job.businessProfileId,
        correlationId: job.correlationId,
        conversationId: job.conversationId,
        deliveryJobId: job.deliveryJobId,
        operationId: job.operationId,
        reason,
        detectedAt: now().toISOString(),
        ...(result?.outcome === "AMBIGUOUS" && result.providerRequestId !== undefined
          ? { providerRequestId: result.providerRequestId }
          : {}),
        ...(result?.outcome === "AMBIGUOUS" && result.code !== undefined ? { providerCode: result.code } : {}),
      });
      jobLogger.warn("queue.delivery_quarantined", { reason, operationId: job.operationId });
    } catch (error) {
      jobLogger.error("queue.reconciliation_enqueue_failed", { reason, operationId: job.operationId, errorName: errorName(error) });
      // Never let a failed quarantine turn into a queue retry of the send.
      throw new UnrecoverableError("delivery outcome unknown and reconciliation could not be enqueued");
    }
  }


  const workers = [
    worker(INBOUND_DEBOUNCE, async (job, context) => {
      const replyCycle = await replyCycles.ownership(job);
      if (replyCycle === "SUPERSEDED") {
        context.logger.info("queue.debounce_superseded_on_wake", { anchorMessageId: job.anchorMessageId });
        return "SUPERSEDED";
      }
      await handlers.onInboundDebounceElapsed(job, { ...context, replyCycle });
      return "HANDLED";
    }),

    worker(AI_DRAFT_GENERATION, async (job, context) => {
      await handlers.generateAiDraft(job, context);
      return "HANDLED";
    }),

    worker(
      DELIVERY,
      async (job, context) => {
        let attempt: DeliveryAttemptResult;
        try {
          attempt = await handlers.deliver(job, context);
        } catch {
          await quarantine(job, "DELIVERY_HANDLER_FAILED", context.logger);
          throw new UnrecoverableError("delivery outcome unknown; quarantined for reconciliation");
        }

        switch (attempt.status) {
          case "SKIPPED":
            context.logger.info("queue.delivery_skipped", { reason: attempt.reason });
            return "SKIPPED";
          case "NOT_CLAIMED":
            if (attempt.retryable) {
              throw new Error("delivery was not claimed; retrying");
            }
            return "NOT_CLAIMED";
          case "SEND_RESULT": {
            let disposition: SendDisposition;
            let result: SendResult;
            try {
              result = parseSendResult(attempt.result);
              disposition = sendDisposition(result);
            } catch {
              await quarantine(job, "DELIVERY_HANDLER_FAILED", context.logger);
              return "QUARANTINED";
            }
            switch (disposition) {
              case "COMPLETED":
                return "SENT";
              case "RETRY_ALLOWED":
                // Explicit provider rejection: nothing was delivered, so the retry policy applies.
                throw new Error("provider rejected the send as retryable");
              case "FAILED":
                context.logger.warn("queue.delivery_rejected", { operationId: job.operationId });
                return "REJECTED";
              case "QUARANTINE_NO_RETRY":
                await quarantine(job, "AMBIGUOUS_SEND_RESULT", context.logger, result);
                return "QUARANTINED";
            }
          }
        }
      },
      {
        // A delivery whose worker died mid-run is failed, never re-run: the send may have happened (ADR-012).
        maxStalledCount: 0,
        onFailed: async (job, error) => {
          if (error.message !== STALLED_FAILURE) {
            return;
          }
          let payload: DeliveryJob;
          try {
            payload = parsePayload(DELIVERY.schema, DELIVERY.jobName, job.data);
          } catch {
            return;
          }
          await quarantine(payload, "DELIVERY_STALLED", logger.child(bindingsFor(DELIVERY, job, payload))).catch(() => undefined);
        },
      },
    ),

    worker(RECONCILIATION, async (job, context) => {
      await handlers.reconcile(job, context);
      return "HANDLED";
    }),
  ];

  /**
   * The limits for one queue: an explicit override, then the per-queue default, then the caller's single
   * fallback number. A queue that fell through every one of those would run unbounded against whatever
   * dependency it talks to, so it ends at 1 rather than at BullMQ's own default.
   */
  function limitsFor(family: { readonly queueName: string }): QueueExecutionLimits {
    return options.limits?.[family.queueName] ?? DEFAULT_QUEUE_LIMITS[family.queueName] ?? { concurrency: options.concurrency ?? 1 };
  }

  function worker<Payload extends { readonly workspaceId: string; readonly businessProfileId: string; readonly correlationId: string }>(
    family: JobFamily<Payload>,
    handle: (payload: Payload, context: JobContext) => Promise<JobOutcome>,
    extra: {
      readonly maxStalledCount?: number;
      readonly onFailed?: (job: Job, error: Error) => Promise<void>;
    } = {},
  ): Worker {
    const limits = limitsFor(family);
    const created = new Worker(
      family.queueName,
      async (job: Job): Promise<{ outcome: JobOutcome }> => {
        if (job.name !== family.jobName) {
          logger.error("queue.job_rejected", { queue: family.queueName, jobId: job.id, jobName: job.name, reason: "UNKNOWN_JOB_NAME" });
          throw new UnrecoverableError("unknown job name");
        }
        let payload: Payload;
        try {
          payload = parsePayload(family.schema, family.jobName, job.data);
        } catch (error) {
          logger.error("queue.job_rejected", {
            queue: family.queueName,
            jobId: job.id,
            jobName: job.name,
            reason: "INVALID_PAYLOAD",
            issues: error instanceof JobPayloadValidationError ? error.issues : [],
          });
          throw new UnrecoverableError("invalid job payload");
        }

        const attempt = job.attemptsMade + 1;
        const jobLogger = logger.child(bindingsFor(family, job, payload));
        jobLogger.info("queue.job_started", { attempt });
        try {
          const outcome = await handle(payload, { jobId: job.id ?? "", attempt, logger: jobLogger });
          jobLogger.info("queue.job_completed", { attempt, outcome });
          return { outcome };
        } catch (error) {
          const retryable =
            !(error instanceof UnrecoverableError) &&
            !(error instanceof NonRetryableJobError) &&
            attempt < (job.opts.attempts ?? 1);
          const failedWith = errorName(error);
          jobLogger[retryable ? "warn" : "error"]("queue.job_failed", { attempt, willRetry: retryable, errorName: failedWith });
          reportFailure({
            queueName: family.queueName,
            workspaceId: payload.workspaceId,
            businessProfileId: payload.businessProfileId,
            ...("conversationId" in payload && typeof payload.conversationId === "string" ? { conversationId: payload.conversationId } : {}),
            errorName: failedWith,
            willRetry: retryable,
          });
          if (error instanceof NonRetryableJobError) {
            throw new UnrecoverableError(error.message);
          }
          throw error;
        }
      },
      {
        // Connection options, not the shared instance: BullMQ then owns (and cleanly closes) the worker's
        // connections, including when shutdown starts before Redis was ever reachable.
        connection: { ...options.connection.options },
        prefix,
        concurrency: limits.concurrency,
        ...(limits.rateLimit === undefined ? {} : { limiter: { max: limits.rateLimit.max, duration: limits.rateLimit.durationMs } }),
        ...(options.lockDurationMs === undefined ? {} : { lockDuration: options.lockDurationMs }),
        ...(options.stalledIntervalMs === undefined ? {} : { stalledInterval: options.stalledIntervalMs }),
        ...(extra.maxStalledCount === undefined ? {} : { maxStalledCount: extra.maxStalledCount }),
      },
    );
    created.on("error", (error: Error) => {
      // While Redis is unreachable every retry surfaces here; the connection already logged the outage once.
      if (options.connection.status !== "ready") {
        return;
      }
      logger.error("queue.worker_error", { queue: family.queueName, errorName: errorName(error) });
    });
    const { onFailed } = extra;
    if (onFailed !== undefined) {
      created.on("failed", (job: Job | undefined, error: Error) => {
        if (job !== undefined) {
          // Caught, not `void`ed.
          //
          // `void` does not handle a rejection; it silences the lint rule and nothing else. So a failure
          // handler that itself failed became an unhandled rejection, the process guard read that as
          // unknown state, and the worker logged `worker.fatal` and exited 1.
          //
          // The case that actually happens: Redis goes down, a job fails because of it, and this handler
          // reaches for Redis to record the failure. Killing the worker there is the exact opposite of
          // riding out an outage, which is what it claims to do — and because it needs a job to fail
          // inside the outage, it killed the process about once in thirteen runs rather than every time.
          //
          // Same shape as `reportFailure` above, and the same event: a reporter's own failure must never
          // become the process's problem.
          onFailed(job, error).catch((failure: unknown) => {
            logger.warn("queue.failure_report_failed", { queue: family.queueName, errorName: errorName(failure) });
          });
        }
      });
    }
    return created;
  }

  /**
   * Every worker's own first connection attempt, settled.
   *
   * BullMQ drops its error listeners on close, so a first attempt that fails *after* close surfaces as an
   * unhandled rejection — and the process guard reads that as unknown state and kills the worker.
   *
   * This used to wait on the shared connection and then add a fixed 50ms "grace period for the workers'
   * own connections". That grace was a guess standing in for a fact that can be asked for directly, and
   * under load it was not enough: the bundle test SIGTERMs the moment `worker.started` appears, which is
   * logged synchronously before anything is connected, so close raced the first attempt and the worker
   * died about once in three runs on a busy machine.
   *
   * `waitUntilReady()` is that fact, per worker. The timeout stays as a bound rather than a guess: with
   * `maxRetriesPerRequest: null` a worker retries a dead Redis forever, and close must not wait for it.
   */
  const connectionAttemptsSettled = Promise.race([
    Promise.all(workers.map((created) => created.waitUntilReady().catch(() => undefined))).then(() => undefined),
    new Promise<void>((resolve) => {
      setTimeout(resolve, CONNECTION_SETTLE_TIMEOUT_MS).unref();
    }),
  ]);

  return {
    queueNames: workers.map((created) => created.name),
    async close({ force = false } = {}) {
      await connectionAttemptsSettled;
      await closeAll("workers", workers, async (created) => created.close(force), logger);
      await reconciliation.close();
    },
  };
}

function bindingsFor(
  family: JobFamily<unknown>,
  job: Job,
  payload: { readonly workspaceId: string; readonly businessProfileId: string; readonly correlationId: string },
) {
  return {
    queue: family.queueName,
    jobName: family.jobName,
    jobId: job.id,
    workspaceId: payload.workspaceId,
    businessProfileId: payload.businessProfileId,
    correlationId: payload.correlationId,
  };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
