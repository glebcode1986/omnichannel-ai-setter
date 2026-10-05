/**
 * @omnichannel/queue
 *
 * BullMQ job contracts and durable scheduling primitives (ADR-003, ADR-005, ADR-012, DELAY_ENGINE.md):
 * inbound debounce with reply-cycle supersession, AI draft triggers, delayed delivery and reconciliation.
 * Channel-neutral: no Meta/Instagram/WhatsApp logic and no provider sends.
 */
export { createRedisConnection, type RedisRole } from "./connection";
export { deliveryDelayFor, planDelay, ScheduleRangeError, type DelayPlan, type ScheduleRejection } from "./delay";
export {
  AI_DRAFT_GENERATION,
  buildJobId,
  DEFAULT_QUEUE_LIMITS,
  DEFAULT_QUEUE_PREFIX,
  DELIVERY,
  INBOUND_DEBOUNCE,
  MEDIA_TRANSCRIPTION,
  JOB_FAMILIES,
  RECONCILIATION,
  type JobFamily,
  type QueueExecutionLimits,
} from "./families";
export {
  AI_DRAFT_TRIGGERS,
  aiDraftGenerationJobSchema,
  deliveryJobSchema,
  inboundDebounceJobSchema,
  JobPayloadValidationError,
  MAX_SCHEDULE_DELAY_MS,
  reconciliationJobSchema,
  type AiDraftGenerationJob,
  type DeliveryJob,
  type InboundDebounceJob,
  type MediaTranscriptionJob,
  type PayloadIssue,
  type ReconciliationJob,
} from "./payloads";
export { createQueueMonitor, type QueueDepth, type QueueMonitor, type QueueMonitorOptions } from "./monitor";
export {
  createQueueProducer,
  type DebounceScheduleResult,
  type EnqueuedJob,
  type QueueProducer,
  type QueueProducerOptions,
  type RaiseOptions,
} from "./producer";
// One list, owned by the domain: the queue only re-exports it so a job payload and the
// reconciliation consumer cannot drift apart.
export { RECONCILIATION_REASONS, type ReconciliationReason } from "@omnichannel/domain";
export type { ReplyCycleClaim, ReplyCycleOwnership } from "./reply-cycle";
export {
  createQueueWorkers,
  NonRetryableJobError,
  type DeliveryAttemptResult,
  type JobContext,
  type JobFailure,
  type JobOutcome,
  type QueueHandlers,
  type QueueWorkers,
  type QueueWorkersOptions,
} from "./workers";
