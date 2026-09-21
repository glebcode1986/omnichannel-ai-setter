/**
 * @omnichannel/application
 *
 * Use cases, orchestration and the ports infrastructure implements (e.g. AI ReplyModel/EmbeddingProvider).
 * Pure and runtime-agnostic: no Node.js built-ins/globals and no concrete infrastructure (db, queue, ai) or channel adapters.
 * Allowed workspace dependencies are enforced by `pnpm lint:boundaries` (see docs/specs/REPOSITORY_LAYOUT.md).
 */
export {
  ingestWebhook,
  type IngestionDependencies,
  type IngestionSummary,
  type WebhookIngestionRequest,
  type WebhookIngestionResult,
} from "./ingestion/ingest-webhook";
export { dispatchOutbox, type OutboxDispatchDependencies, type OutboxDispatchResult } from "./ingestion/outbox";
export type {
  ChannelAdapterProvider,
  ConversationSnapshot,
  DebounceScheduler,
  InboundDebouncePayload,
  IngestionOutcome,
  IngestionStore,
  IngestionTransaction,
  LogPort,
  OutboxEntry,
  SourceEventKey,
  StoredMessageStatus,
  WebhookAccount,
  VerificationFailure,
} from "./ingestion/ports";
export { VERIFICATION_FAILURES } from "./ingestion/ports";
export { processEvent, type EventProcessingContext, type EventProcessingResult } from "./ingestion/process-event";
export { isEligibleForInboundDebounce, nextDeliveryStatus, outboxRetryDelayMs, sampleDelayMs } from "./ingestion/rules";
