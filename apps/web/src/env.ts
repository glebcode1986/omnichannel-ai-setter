import { parseEnv, runtimeEnvSchema, type EnvSource } from "@omnichannel/env";
import { z } from "zod";

/**
 * Server-side web environment contract. Never expose these values to client components.
 */
export const webEnvSchema = runtimeEnvSchema.extend({
  /** PostgreSQL connection string (ADR-005). */
  DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/ }),
  /** Auth.js secret used to sign/encrypt session cookies and tokens (ADR-009). */
  AUTH_SECRET: z.string().min(32),
  /** Redis for enqueueing BullMQ work from webhook ingestion (ADR-005). */
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),

  /** Identifies the key that encrypts stored provider credentials; rows record it so keys can be rotated. */
  CHANNEL_CREDENTIAL_KEY_ID: z.string().min(1).max(64),
  /** 32-byte AES-256-GCM key, base64 encoded (44 characters). Never logged, never sent to the browser. */
  CHANNEL_CREDENTIAL_KEY: z.base64().length(44),
  /** Meta app credentials for Instagram Login (ADR-006). */
  INSTAGRAM_APP_ID: z.string().min(1).max(64),
  INSTAGRAM_APP_SECRET: z.string().min(1).max(256),
  /** Exactly the HTTPS redirect URI registered with Meta; never derived from an incoming request. */
  INSTAGRAM_REDIRECT_URI: z.url({ protocol: /^https$/ }),
  /**
   * Token echoed back to Meta during the webhook subscription handshake. Optional so a deployment that
   * does not receive Instagram webhooks still boots; where it is absent no Instagram adapter is bound at
   * all, so webhooks are refused before signature verification, persistence or enqueue rather than
   * accepted unverified. Validated for shape when present, and never logged or returned in a response.
   */
  INSTAGRAM_VERIFY_TOKEN: z.string().min(16).max(256).optional(),
  /**
   * Whether Meta approved the Human Agent feature for this app. No API exposes it, so it is operator-entered
   * and defaults to UNKNOWN, which keeps the human-agent send path closed.
   */
  INSTAGRAM_HUMAN_AGENT_APPROVAL: z.enum(["APPROVED", "NOT_APPROVED", "UNKNOWN"]).default("UNKNOWN"),

  /**
   * Embeddings, for the Knowledge Library's retrieval tester only (ADR-011, Issue #31).
   *
   * These must match the worker's. The tester exists to answer "would the assistant find this fact?", and
   * a tester configured differently from the process that actually retrieves answers a different question
   * — one an operator would act on. Absent is supported and honest: retrieval runs lexical-only, the
   * worker does the same with the same setting, and the tester says on screen which mode it is in.
   *
   * Nothing here is used to *write* embeddings. Indexing is the worker's, and the web app never chunks.
   */
  VOYAGE_API_KEY: z.string().min(1).max(512).optional(),
  AI_EMBEDDING_MODEL: z.string().min(1).max(128).default("voyage-3.5"),
  AI_EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().max(4_096).default(1_024),
  AI_EMBEDDING_REVISION: z.string().min(1).max(32).default("v1"),
});

export type WebEnv = ReturnType<typeof loadWebEnv>;

export function loadWebEnv(source: EnvSource = process.env) {
  return parseEnv(webEnvSchema, source);
}
