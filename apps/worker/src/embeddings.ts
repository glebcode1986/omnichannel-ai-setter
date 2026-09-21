/**
 * Choosing an embedding provider, or deliberately choosing none (ADR-011).
 *
 * Extracted from the composition root so the decision can be tested. It is small, but it decides whether
 * retrieval runs hybrid or lexical-only for the lifetime of the process, and one way of getting it wrong
 * is silent in the worst way: a configured width that disagrees with the `vector(N)` column can never
 * match a stored vector, so every semantic query returns nothing and every draft is held for review.
 * Retrieval would look like it was working and would answer nothing.
 *
 * It does not stop the worker. Taking ingestion down over a retrieval setting would turn a degraded
 * feature into an outage, and lexical-only is a supported mode: a fact it misses becomes MISSING_FACT and
 * human review, never an invented answer. So the worker runs in that mode and says so loudly.
 */
import { createVoyageEmbeddingProvider } from "@omnichannel/ai";
import { EMBEDDING_DIMENSIONS } from "@omnichannel/db";
import type { Logger } from "@omnichannel/observability";

import type { WorkerEnv } from "./env";

export function createEmbeddings(env: WorkerEnv, logger: Logger): ReturnType<typeof createVoyageEmbeddingProvider> | undefined {
  if (env.VOYAGE_API_KEY === undefined) {
    return undefined;
  }
  if (env.AI_EMBEDDING_DIMENSIONS !== EMBEDDING_DIMENSIONS) {
    logger.error("worker.embedding_dimensions_mismatch", {
      configured: env.AI_EMBEDDING_DIMENSIONS,
      column: EMBEDDING_DIMENSIONS,
    });
    return undefined;
  }
  return createVoyageEmbeddingProvider({
    apiKey: env.VOYAGE_API_KEY,
    model: env.AI_EMBEDDING_MODEL,
    dimensions: env.AI_EMBEDDING_DIMENSIONS,
    revision: env.AI_EMBEDDING_REVISION,
    logger,
  });
}
