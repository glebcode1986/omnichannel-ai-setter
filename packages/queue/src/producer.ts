import type { Logger } from "@omnichannel/observability";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";

import {
  AI_DRAFT_GENERATION,
  DEFAULT_QUEUE_PREFIX,
  DELIVERY,
  INBOUND_DEBOUNCE,
  RECONCILIATION,
  type JobFamily,
} from "./families";
import {
  MAX_SCHEDULE_DELAY_MS,
  parsePayload,
  type AiDraftGenerationJob,
  type DeliveryJob,
  type InboundDebounceJob,
  type ReconciliationJob,
} from "./payloads";
import { deliveryDelayFor } from "./delay";
import { createReplyCycleRegistry } from "./reply-cycle";

export interface EnqueuedJob {
  readonly queueName: string;
  readonly jobId: string;
  readonly delayMs: number;
}

export type DebounceScheduleResult =
  | { readonly status: "SCHEDULED"; readonly job: EnqueuedJob; readonly supersededJobId?: string }
  /** A newer inbound message already owns the reply cycle; nothing was left scheduled for this one. */
  | { readonly status: "STALE"; readonly currentAnchorMessageId: string };

export interface QueueProducer {
  /** Stage A: (re)starts the debounce window for the newest inbound message of a conversation. */
  scheduleInboundDebounce(job: InboundDebounceJob, options: { readonly delayMs: number }): Promise<DebounceScheduleResult>;
  enqueueAiDraftGeneration(job: AiDraftGenerationJob): Promise<EnqueuedJob>;
  /** Stage B: durable delayed delivery at `job.scheduledFor`; never sleeps in the caller. */
  scheduleDelivery(job: DeliveryJob, options?: RaiseOptions): Promise<EnqueuedJob>;
  enqueueReconciliation(job: ReconciliationJob, options?: RaiseOptions): Promise<EnqueuedJob>;
  close(): Promise<void>;
}

export interface RaiseOptions {
  /**
   * Raise this work again even though a finished job with the same identity is still retained.
   *
   * For recovery paths only. An ordinary enqueue must stay a no-op when the work already exists — that
   * deduplication is what makes a retried producer safe.
   */
  readonly replaceRetained?: boolean;
}

export interface QueueProducerOptions {
  /** Shared ioredis connection; owned (and closed) by the caller. */
  readonly connection: Redis;
  readonly logger: Logger;
  readonly prefix?: string;
  readonly now?: () => Date;
}

export function createQueueProducer(options: QueueProducerOptions): QueueProducer {
  const prefix = options.prefix ?? DEFAULT_QUEUE_PREFIX;
  const now = options.now ?? (() => new Date());
  const queues = new Map<string, Queue>();
  const replyCycles = createReplyCycleRegistry(options.connection, prefix);

  const queueFor = (family: { readonly queueName: string }): Queue => {
    let queue = queues.get(family.queueName);
    if (queue === undefined) {
      queue = new Queue(family.queueName, { connection: options.connection, prefix });
      queues.set(family.queueName, queue);
    }
    return queue;
  };

  /**
   * Clears a retained record of the same logical work so it can be raised again.
   *
   * Job IDs are deterministic, and completed and failed jobs are retained for days. Adding an ID that
   * already exists is a silent no-op — which is exactly right for a duplicate enqueue and exactly wrong
   * for recovery: a reconciliation that exhausted its attempts, or a delivery quarantined after an
   * ambiguous send, would be permanently unraisable by the very sweeper that exists to raise it.
   *
   * A job that is currently running is not removed, and the add that follows is then the ordinary no-op:
   * something already owns this work, which is the answer recovery wanted anyway.
   */
  async function clearRetained(family: { readonly queueName: string }, jobId: string): Promise<void> {
    try {
      await queueFor(family).remove(jobId);
    } catch {
      // Locked, or already gone. Both mean "leave it alone".
    }
  }

  async function add<Payload extends { readonly workspaceId: string; readonly businessProfileId: string; readonly correlationId: string }>(
    family: JobFamily<Payload>,
    payload: Payload,
    delayMs: number,
    raise: RaiseOptions = {},
  ): Promise<EnqueuedJob> {
    if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > MAX_SCHEDULE_DELAY_MS) {
      throw new RangeError(`delayMs must be an integer between 0 and ${MAX_SCHEDULE_DELAY_MS}`);
    }
    const jobId = family.jobId(payload);
    if (raise.replaceRetained === true) {
      await clearRetained(family, jobId);
    }
    await queueFor(family).add(family.jobName, payload, { ...family.jobOptions, jobId, delay: delayMs });
    options.logger.info("queue.enqueued", {
      queue: family.queueName,
      jobName: family.jobName,
      jobId,
      delayMs,
      workspaceId: payload.workspaceId,
      businessProfileId: payload.businessProfileId,
      correlationId: payload.correlationId,
    });
    return { queueName: family.queueName, jobId, delayMs };
  }

  return {
    async scheduleInboundDebounce(input, { delayMs }) {
      const payload = parsePayload(INBOUND_DEBOUNCE.schema, INBOUND_DEBOUNCE.jobName, input);
      // Enqueue before claiming: a crash between the two leaves at worst a job that wakes up superseded,
      // never a claimed reply cycle without a job.
      const job = await add(INBOUND_DEBOUNCE, payload, delayMs);
      const claim = await replyCycles.claim(payload);
      const queue = queueFor(INBOUND_DEBOUNCE);
      const logFields = {
        jobId: job.jobId,
        workspaceId: payload.workspaceId,
        businessProfileId: payload.businessProfileId,
        correlationId: payload.correlationId,
      };

      if (claim.status === "STALE") {
        await queue.remove(job.jobId);
        options.logger.info("queue.debounce_stale_inbound", logFields);
        return { status: "STALE", currentAnchorMessageId: claim.currentAnchorMessageId };
      }
      if (claim.status === "CLAIMED" && claim.previousAnchorMessageId !== undefined) {
        const supersededJobId = INBOUND_DEBOUNCE.jobId({ ...payload, anchorMessageId: claim.previousAnchorMessageId });
        // Best effort: an active (locked) job is not removed and instead finds itself superseded when it runs.
        const removed = (await queue.remove(supersededJobId)) === 1;
        options.logger.info("queue.debounce_superseded", { ...logFields, supersededJobId, removed });
        return { status: "SCHEDULED", job, supersededJobId };
      }
      return { status: "SCHEDULED", job };
    },

    async enqueueAiDraftGeneration(input) {
      return add(AI_DRAFT_GENERATION, parsePayload(AI_DRAFT_GENERATION.schema, AI_DRAFT_GENERATION.jobName, input), 0);
    },

    async scheduleDelivery(input, options = {}) {
      const payload = parsePayload(DELIVERY.schema, DELIVERY.jobName, input);
      // Throws before `add` is reached, so a refused schedule leaves no job behind and touches nothing.
      // Ordering matters here: the refusal has to happen before anything is cleared, or a resume with an
      // impossible schedule would remove the retained job and then create nothing in its place.
      const delayMs = deliveryDelayFor(payload, now());
      return add(DELIVERY, payload, delayMs, options);
    },

    async enqueueReconciliation(input, options = {}) {
      return add(RECONCILIATION, parsePayload(RECONCILIATION.schema, RECONCILIATION.jobName, input), 0, options);
    },

    async close() {
      await Promise.all([...queues.values()].map((queue) => queue.close()));
      queues.clear();
    },
  };
}
