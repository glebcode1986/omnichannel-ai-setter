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
  scheduleDelivery(job: DeliveryJob): Promise<EnqueuedJob>;
  enqueueReconciliation(job: ReconciliationJob): Promise<EnqueuedJob>;
  close(): Promise<void>;
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

  async function add<Payload extends { readonly workspaceId: string; readonly correlationId: string }>(
    family: JobFamily<Payload>,
    payload: Payload,
    delayMs: number,
  ): Promise<EnqueuedJob> {
    if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > MAX_SCHEDULE_DELAY_MS) {
      throw new RangeError(`delayMs must be an integer between 0 and ${MAX_SCHEDULE_DELAY_MS}`);
    }
    const jobId = family.jobId(payload);
    await queueFor(family).add(family.jobName, payload, { ...family.jobOptions, jobId, delay: delayMs });
    options.logger.info("queue.enqueued", {
      queue: family.queueName,
      jobName: family.jobName,
      jobId,
      delayMs,
      workspaceId: payload.workspaceId,
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
      const logFields = { jobId: job.jobId, workspaceId: payload.workspaceId, correlationId: payload.correlationId };

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

    async scheduleDelivery(input) {
      const payload = parsePayload(DELIVERY.schema, DELIVERY.jobName, input);
      const delayMs = Math.max(0, Date.parse(payload.scheduledFor) - now().getTime());
      return add(DELIVERY, payload, Math.min(delayMs, MAX_SCHEDULE_DELAY_MS));
    },

    async enqueueReconciliation(input) {
      return add(RECONCILIATION, parsePayload(RECONCILIATION.schema, RECONCILIATION.jobName, input), 0);
    },

    async close() {
      await Promise.all([...queues.values()].map((queue) => queue.close()));
      queues.clear();
    },
  };
}
