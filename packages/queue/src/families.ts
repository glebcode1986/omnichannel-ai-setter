/**
 * Central, typed registry of queues, job names, retry policies and deterministic job identities.
 */
import type { JobsOptions } from "bullmq";
import type { z } from "zod";

import {
  aiDraftGenerationJobSchema,
  deliveryJobSchema,
  inboundDebounceJobSchema,
  mediaTranscriptionJobSchema,
  presenceJobSchema,
  reconciliationJobSchema,
  type AiDraftGenerationJob,
  type DeliveryJob,
  type InboundDebounceJob,
  type MediaTranscriptionJob,
  type PresenceJob,
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

export const MEDIA_TRANSCRIPTION: JobFamily<MediaTranscriptionJob> = {
  queueName: "media-transcription",
  jobName: "media-transcription.v1",
  schema: mediaTranscriptionJobSchema,
  // One job per message: a redelivered webhook — which the provider sends for up to seven days — must not
  // queue a second reading of the same recording.
  jobId: (job) => buildJobId("media-transcription", 1, job.workspaceId, job.businessProfileId, job.messageId),
  /**
   * Retried, because every failure that reaches the queue is one that might not repeat: a throttled
   * provider, an outage, a download that timed out. The failures that *will* repeat — an unsupported
   * container, a recording too large, a refused credential — are recorded as terminal by the handler and
   * never thrown, so they do not consume attempts.
   *
   * The backoff is long by comparison with the other families. Nothing is waiting on a reading the way a
   * customer waits on a reply: the draft that needs it holds for a person in the meantime, and reading a
   * recording a minute later costs nothing, while hammering a rate-limited transcriber costs the next
   * recording too.
   */
  jobOptions: { ...RETENTION, attempts: 4, backoff: { type: "exponential", delay: 15_000 } },
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
      // job; automation for one anchor is always the same job, however many times it is retried. A
      // follow-up attempt is its own job for the same reason a person's request is — and it must be,
      // because every attempt of one follow-up shares the anchor, so without the attempt in the id a
      // second allowed attempt would be silently dropped as a duplicate of the first. Which also makes a
      // re-enqueued attempt exactly one job: the duplicate-queue-job case.
      ...(job.trigger.kind === "HUMAN_REQUEST"
        ? [job.trigger.kind, job.trigger.requestId]
        : job.trigger.kind === "FOLLOW_UP"
          ? [job.trigger.kind, job.trigger.followUpId, String(job.trigger.attempt)]
          : [job.trigger.kind]),
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

export const PRESENCE: JobFamily<PresenceJob> = {
  queueName: "presence",
  jobName: "presence.v1",
  schema: presenceJobSchema,
  // One announcement per scheduled reply. A second job for the same operation would be a second typing
  // indicator for one reply, and the deterministic id makes that impossible rather than merely unlikely.
  jobId: (job) => buildJobId("presence", 1, job.workspaceId, job.businessProfileId, job.operationId),
  /**
   * One attempt, and that is the whole policy.
   *
   * Every other family retries because the work still needs doing. This one does not: the announcement is
   * only meaningful in the seconds before the reply, so a retry a minute later would raise a typing
   * indicator after the message had already arrived — worse than the silence it was trying to fix. The
   * handler therefore never throws, and the attempt count says so out loud.
   */
  jobOptions: { ...RETENTION, attempts: 1 },
};

export const JOB_FAMILIES = [INBOUND_DEBOUNCE, MEDIA_TRANSCRIPTION, AI_DRAFT_GENERATION, PRESENCE, DELIVERY, RECONCILIATION] as const;

/**
 * How much work one worker process may have in flight per queue, and how fast it may start it.
 *
 * These are the concurrency limits that keep one failure from becoming a dependency storm, and they are
 * per queue because the queues have nothing in common except the process they run in. Storing a burst of
 * webhooks is cheap and touches only our own database; asking a language model is expensive, rate-limited
 * by the provider, and the fastest way to turn a slow provider into a refusing one; sending is bounded by
 * the platform's own limits, and exceeding those costs the account rather than the request.
 *
 * A rate limit is expressed as "at most `max` jobs started per `durationMs`" and is enforced by BullMQ
 * across every worker sharing the queue, not per process — which is what makes it meaningful once more
 * than one worker runs.
 *
 * The numbers are starting points chosen to be obviously safe rather than optimal, and every one of them
 * is overridable from the environment: the right value depends on the provider tier and the account,
 * neither of which this file can know.
 */
export interface QueueExecutionLimits {
  readonly concurrency: number;
  readonly rateLimit?: { readonly max: number; readonly durationMs: number };
}

export const DEFAULT_QUEUE_LIMITS: Readonly<Record<string, QueueExecutionLimits>> = {
  // Database-only and short. Running these in parallel is how a burst of webhooks stops being a backlog.
  [INBOUND_DEBOUNCE.queueName]: { concurrency: 8 },
  /**
   * One provider, charged per minute of audio and rate-limited by tier — 500 requests a minute on the
   * lowest paid tier, which is far above anything this concurrency can produce. The limit here is about
   * the *uploads*: each job downloads a recording and posts it again, so the cost of running many at once
   * is bandwidth and memory rather than tokens.
   */
  [MEDIA_TRANSCRIPTION.queueName]: { concurrency: 2, rateLimit: { max: 60, durationMs: 60_000 } },
  // One provider, charged per token and rate-limited by tier. Concurrency here is the storm risk.
  [AI_DRAFT_GENERATION.queueName]: { concurrency: 2, rateLimit: { max: 30, durationMs: 60_000 } },
  /**
   * Cheap, short and time-critical: one small POST that is worthless a few seconds late. Higher
   * concurrency than delivery on purpose — a presence job that queues behind others misses its moment,
   * and the provider documents no separate limit for these calls.
   */
  [PRESENCE.queueName]: { concurrency: 8, rateLimit: { max: 120, durationMs: 60_000 } },
  // Bounded by the platform's own send limits; exceeding them is charged to the account, not the request.
  [DELIVERY.queueName]: { concurrency: 4, rateLimit: { max: 60, durationMs: 60_000 } },
  // Investigation only, and it never sends. Low, because it is never the urgent work.
  [RECONCILIATION.queueName]: { concurrency: 2 },
};
