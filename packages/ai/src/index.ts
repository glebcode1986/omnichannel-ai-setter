/**
 * @omnichannel/ai
 *
 * Concrete model-provider implementations of the ports declared by `@omnichannel/application` (ADR-010).
 * Provider wire formats, prompts and error shapes stay inside this package; application and domain code see
 * only the normalized port. The provider and model are configuration supplied by the composition root.
 */
export {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_MESSAGES_URL,
  createAnthropicReplyModel,
  PROVIDER_NAME,
  type AnthropicReplyModelConfig,
} from "./reply-model";
export {
  createVoyageEmbeddingProvider,
  DEFAULT_EMBEDDING_DIMENSIONS,
  EMBEDDING_PROVIDER_NAME,
  embeddingProfileId,
  VOYAGE_EMBEDDINGS_URL,
  type VoyageEmbeddingConfig,
} from "./embedding-provider";
export { createFetchModelHttpPort, type ModelHttpPort, type ModelHttpRequest, type ModelHttpResult } from "./transport";
export { AI_DRAFT_JSON_SCHEMA } from "./wire-schema";
export {
  createOpenAiTranscriptionProvider,
  DEFAULT_TRANSCRIPTION_MODEL,
  DOCUMENTED_TRANSCRIPTION_FORMATS,
  MAX_TRANSCRIPTION_BYTES,
  OPENAI_TRANSCRIPTION_URL,
  type OpenAiTranscriptionConfig,
} from "./transcription-provider";
