/**
 * Central, typed registry of queues, job names, retry policies and deterministic job identities.
 */
import type { JobsOptions } from "bullmq";
import type { z } from "zod";

import {
  aiDraftGenerationJobSchema,
  deliveryJobSchema,
  inboundDebounceJobSchema,
  reconciliationJobSchema,
  type AiDraftGenerationJob,
  type DeliveryJob,
  type InboundDebounceJob,
  type ReconciliationJob,
} from "./payloads";

export const DEFAULT_QUEUE_PREFIX = "omnichannel";

const DAY_SECONDS = 24 * 60 * 60;

/**
 * Completed jobs are kept for 7 days and failed jobs for 30 days: a retained job ID makes a duplicate
 * enqueue a no-op within that window and keeps failures inspectable. PostgreSQL operation records remain
 * the authoritative idempotency guard beyond it (ADR-012).
 */
const RETENTION = {
  removeOnComplete: { age: 7 * DAY_SECONDS },
  removeOnFail: { age: 30 * DAY_SECONDS },
} satisfies JobsOptions;

export interface JobFamily<Payload> {
  readonly queueName: string;
  /** Versioned job name; a worker rejects names it does not know instead of guessing the payload shape. */
  readonly jobName: string;
  readonly schema: z.ZodType<Payload>;
  /** Deterministic BullMQ job ID: enqueueing the same logical work twice yields one job. */
  jobId(payload: Payload): string;
  readonly jobOptions: JobsOptions;
}

/** Joins encoded parts with `|`; BullMQ rejects `:` in custom IDs and integer-like IDs. */
export function buildJobId(family: string, version: number, ...parts: readonly string[]): string {
  return [family, `v${version}`, ...parts.map((part) => encodeURIComponent(part))].join("|");
}

export const INBOUND_DEBOUNCE: JobFamily<InboundDebounceJob> = {
  queueName: "inbound-debounce",
  jobName: "inbound-debounce.v1",
  schema: inboundDebounceJobSchema,
  // One job per inbound anchor: re-delivered webhooks for the same message do not add a second timer.
  jobId: (job) => buildJobId("inbound-debounce", 1, job.workspaceId, job.businessProfileId, job.conversationId, job.anchorMessageId),
  // Safe to retry: firing only hands the reply cycle to AI draft generation, which is itself idempotent.
  jobOptions: { ...RETENTION, attempts: 3, backoff: { type: "exponential", delay: 1_000 } },
};

export const AI_DRAFT_GENERATION: JobFamily<AiDraftGenerationJob> = {
  queueName: "ai-draft-generation",
  jobName: "ai-draft-generation.v1",
  schema: aiDraftGenerationJobSchema,
  jobId: (job) =>
    buildJobId(
      "ai-draft-generation",
      1,
      job.workspaceId,
      job.businessProfileId,
      job.conversationId,
      job.anchorMessageId,
      // A person asking twice for the same anchor wants two drafts, so each explicit request is its own
      // job; automation for one anchor is always the same job, however many times it is retried.
      ...(job.trigger.kind === "HUMAN_REQUEST" ? [job.trigger.kind, job.trigger.requestId] : [job.trigger.kind]),
    ),
  // Safe to retry: generation produces a draft, never a customer-visible send.
  jobOptions: { ...RETENTION, attempts: 3, backoff: { type: "exponential", delay: 5_000 } },
};

export const DELIVERY: JobFamily<DeliveryJob> = {
  queueName: "delivery",
  jobName: "delivery.v1",
  schema: deliveryJobSchema,
  // One queue job per logical outbound action, however often scheduling is retried.
  jobId: (job) => buildJobId("delivery", 1, job.workspaceId, job.businessProfileId, job.operationId),
  // Retries happen only when the processor explicitly allows them (not claimed, or a provider rejection
  // marked retryable). Ambiguous or unknown outcomes fail unrecoverably and go to reconciliation.
  jobOptions: { ...RETENTION, attempts: 3, backoff: { type: "exponential", delay: 15_000 } },
};

export const RECONCILIATION: JobFamily<ReconciliationJob> = {
  queueName: "delivery-reconciliation",
  jobName: "delivery-reconciliation.v1",
  schema: reconciliationJobSchema,
  jobId: (job) => buildJobId("delivery-reconciliation", 1, job.workspaceId, job.businessProfileId, job.operationId),
  // Reconciliation only looks up platform/delivery state; it never sends, so retrying it is safe.
  jobOptions: { ...RETENTION, attempts: 5, backoff: { type: "exponential", delay: 30_000 } },
};

export const JOB_FAMILIES = [INBOUND_DEBOUNCE, AI_DRAFT_GENERATION, DELIVERY, RECONCILIATION] as const;
