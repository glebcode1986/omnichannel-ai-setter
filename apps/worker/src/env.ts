import { parseEnv, runtimeEnvSchema, type EnvSource } from "@omnichannel/env";
import { z } from "zod";

/**
 * Worker environment contract. Later issues extend this schema instead of reading `process.env` elsewhere.
 */
export const workerEnvSchema = runtimeEnvSchema.extend({
  /** PostgreSQL (ADR-005): the outbox sweeper reads pending queue work committed by the web app. */
  DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/ }),
  /** Redis for BullMQ scheduling and coordination (ADR-005); not the durable source of truth. */
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),

  /** Model provider credentials. Read once here and passed inward as typed configuration. */
  ANTHROPIC_API_KEY: z.string().min(1).max(512),
  /** Provider choice is configuration, not architecture (AI_ORCHESTRATION.md); swap it without a release. */
  AI_REPLY_MODEL: z.string().min(1).max(128).default("claude-opus-5"),
  AI_REPLY_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  /**
   * Output budget. Generous on purpose: the default model deliberates before answering and that counts
   * against this cap, so a tight budget truncates the reply and every draft is held for review.
   */
  AI_REPLY_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(8_192).default(4_096),
  /**
   * Embeddings provider. Optional on purpose: with no key the worker runs lexical-only retrieval, which is
   * a supported configuration rather than a degraded one — a missed fact produces MISSING_FACT and human
   * review, never an invented answer. Requiring a key would make an embeddings outage a boot failure.
   */
  VOYAGE_API_KEY: z.string().min(1).max(512).optional(),
  AI_EMBEDDING_MODEL: z.string().min(1).max(128).default("voyage-3.5"),
  /** Must match the `vector(N)` column; changing it needs a migration and a controlled re-embedding. */
  AI_EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().max(4_096).default(1_024),
  /** Bumped by hand to force new vectors to be treated as a separate profile. */
  AI_EMBEDDING_REVISION: z.string().min(1).max(32).default("v1"),

  /**
   * The business persona the model writes as. Configuration for now: the data model has no persona field,
   * and the AI configuration UX (Phase 5) owns where a business edits this.
   */
  AI_PERSONA: z
    .string()
    .min(1)
    .max(2_000)
    .default("You are the business's own assistant. Be warm, brief and concrete, and never invent facts."),
});

export type WorkerEnv = ReturnType<typeof loadWorkerEnv>;

export function loadWorkerEnv(source: EnvSource = process.env) {
  return parseEnv(workerEnvSchema, source);
}
