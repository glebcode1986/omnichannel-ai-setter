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
} from "./ingestion/ports";
export { processEvent, type EventProcessingContext, type EventProcessingResult } from "./ingestion/process-event";
export { isEligibleForInboundDebounce, nextDeliveryStatus, outboxRetryDelayMs, sampleDelayMs } from "./ingestion/rules";
export {
  draftGenerationBlockers,
  generateDraft,
  generationKey,
  type DraftGenerationCommand,
  type DraftGenerationDependencies,
  type DraftGenerationOutcome,
  type DraftLogPort,
  type DraftTrigger,
} from "./ai/generate-draft";
export {
  aiDraftOutputSchema,
  MODEL_EMITTABLE_REASON_CODES,
  MODEL_OUTPUT_SCHEMA_VERSION,
  parseModelOutput,
  type AiDraftOutput,
  type ModelOutputIssue,
  type ModelOutputParse,
} from "./ai/model-output";
export {
  ReplyModelUnavailableError,
  type AiDraftStore,
  type ConversationSegment,
  type DraftConversationSnapshot,
  type GenerationScope,
  type KnowledgeSegment,
  type ModelUsage,
  type PersistedDraft,
  type ReplyGenerationRequest,
  type ReplyGenerationResult,
  type ReplyModel,
  type SaveDraftInput,
  type SegmentKind,
  type StyleSegment,
} from "./ai/ports";
export { containsNonce, MAX_SEGMENT_CHARS, sanitizeUntrustedText } from "./ai/sanitize";
export { fuseByReciprocalRank, RRF_K, type FusedCandidate, type RankedCandidate } from "./retrieval/fusion";
export {
  EmbeddingUnavailableError,
  noRetrieval,
  RetrievalUnavailableError,
  type EmbeddingIntent,
  type EmbeddingProvider,
  type EmbeddingVector,
  type KnowledgeHit,
  type KnowledgeRetrievalResult,
  type KnowledgeRetrievalStatus,
  type KnowledgeRetriever,
  type RetrievalDiagnostics,
  type RetrievalQuery,
  type RetrievalScope,
  type RetrievalScopeLevel,
  type RetrievalThresholds,
  type StyleHit,
  type StyleRetrievalResult,
  type StyleRetriever,
  type SuppliedRetrieval,
} from "./retrieval/ports";
export {
  retrieveDraftContext,
  type DraftRetrievalContext,
  type DraftRetrievalDependencies,
  type DraftRetrievalQuery,
  type RetrievalLogPort,
} from "./retrieval/retrieve-draft-context";
