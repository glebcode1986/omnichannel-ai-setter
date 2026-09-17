/**
 * @omnichannel/queue
 *
 * BullMQ job contracts and durable scheduling primitives (ADR-003, ADR-005, ADR-012, DELAY_ENGINE.md):
 * inbound debounce with reply-cycle supersession, AI draft triggers, delayed delivery and reconciliation.
 * Channel-neutral: no Meta/Instagram/WhatsApp logic and no provider sends.
 */
export { createRedisConnection, type RedisRole } from "./connection";
export { planDelay, type DelayPlan } from "./delay";
export {
  AI_DRAFT_GENERATION,
  buildJobId,
  DEFAULT_QUEUE_PREFIX,
  DELIVERY,
  INBOUND_DEBOUNCE,
  JOB_FAMILIES,
  RECONCILIATION,
  type JobFamily,
} from "./families";
export {
  AI_DRAFT_TRIGGERS,
  aiDraftGenerationJobSchema,
  deliveryJobSchema,
  inboundDebounceJobSchema,
  JobPayloadValidationError,
  MAX_SCHEDULE_DELAY_MS,
  RECONCILIATION_REASONS,
  reconciliationJobSchema,
  type AiDraftGenerationJob,
  type DeliveryJob,
  type InboundDebounceJob,
  type PayloadIssue,
  type ReconciliationJob,
  type ReconciliationReason,
} from "./payloads";
export {
  createQueueProducer,
  type DebounceScheduleResult,
  type EnqueuedJob,
  type QueueProducer,
  type QueueProducerOptions,
} from "./producer";
export type { ReplyCycleClaim, ReplyCycleOwnership } from "./reply-cycle";
export {
  createQueueWorkers,
  NonRetryableJobError,
  type DeliveryAttemptResult,
  type JobContext,
  type JobOutcome,
  type QueueHandlers,
  type QueueWorkers,
  type QueueWorkersOptions,
} from "./workers";
