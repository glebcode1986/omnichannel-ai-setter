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
   * The platform's voice of last resort, used only where a business has configured no StyleProfile of its
   * own. A tenant's persona lives in `style_profiles` and is resolved per Business Profile; this is a safe
   * default for an unconfigured workspace, never the authoritative voice for one (decision on PR #65).
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
