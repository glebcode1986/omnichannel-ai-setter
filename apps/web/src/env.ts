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
   * Meta app credentials for WhatsApp Embedded Signup (ADR-015, Issue #19).
   *
   * All three are optional so a deployment that does not offer WhatsApp still boots; where any is absent
   * the connect flow is not composed at all, so the endpoint refuses before touching a database rather
   * than starting a signup it cannot finish.
   *
   * `WHATSAPP_SIGNUP_CONFIG_ID` is the Business Login configuration the client launches. It is the only
   * one of the three that reaches the browser, and it is not a secret: it names which permissions the
   * flow asks for, and Meta will only honour it for this app on an allow-listed domain.
   */
  WHATSAPP_APP_ID: z.string().min(1).max(64).optional(),
  WHATSAPP_APP_SECRET: z.string().min(1).max(256).optional(),
  WHATSAPP_SIGNUP_CONFIG_ID: z.string().min(1).max(64).optional(),
  /**
   * The token Meta echoes back during the webhook subscription handshake.
   *
   * Chosen by this deployment and configured in the App Dashboard, exactly like Instagram's. Without it
   * no WhatsApp adapter is bound, which answers every WhatsApp webhook with a 404 rather than accepting a
   * payload this deployment cannot verify.
   */
  WHATSAPP_VERIFY_TOKEN: z.string().min(1).max(256).optional(),
  /**
   * Graph API version for the onboarding calls.
   *
   * A default of this deployment rather than a constant of the code: Meta deprecates a version after two
   * years, and moving with them must not need a release. Embedded Signup v2 and v3 die on 2026-10-15, so
   * the client flow is v4 regardless of what this says — this is the Graph version, not the flow's.
   */
  WHATSAPP_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/u).max(16).default("v26.0"),

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
  /**
   * The reply model, for the simulation playground and the Style screen's test (Issues #30, #32).
   *
   * Optional, unlike the worker's, where a missing key means no draft can ever be produced and booting
   * without one would be booting broken. Here a missing key costs part of two read-only screens, and both
   * of them say so: the playground still runs retrieval and the deterministic policy, and the Style test
   * still shows the effective voice and the examples retrieval would pick. A deployment that never wants
   * the web app talking to a provider gets that by leaving this unset, which is a supported configuration
   * rather than a degraded one.
   *
   * Neither surface can send, whether this is set or not. The `ReplyModel` port has no transport, no
   * recipient and no tools, so a live run against a real provider still cannot reach a customer.
   */
  ANTHROPIC_API_KEY: z.string().min(1).max(512).optional(),
  AI_REPLY_MODEL: z.string().min(1).max(128).default("claude-opus-5"),
  AI_REPLY_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(8_192).default(4_096),
  AI_EMBEDDING_MODEL: z.string().min(1).max(128).default("voyage-3.5"),
  AI_EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().max(4_096).default(1_024),
  AI_EMBEDDING_REVISION: z.string().min(1).max(32).default("v1"),

  /**
   * The platform's voice of last resort, used by the Style test only where a business has configured no
   * StyleProfile of its own.
   *
   * It must carry the same value as the worker's, for the same reason the embedding settings must: the
   * test exists to answer "how will the assistant sound?", and a fallback persona that differs from the
   * one the worker drafts with answers a different question.
   */
  AI_PERSONA: z
    .string()
    .min(1)
    .max(2_000)
    .default("You are the business's own assistant. Be warm, brief and concrete, and never invent facts."),
});

export type WebEnv = ReturnType<typeof loadWebEnv>;

export function loadWebEnv(source: EnvSource = process.env) {
  return parseEnv(webEnvSchema, source);
}
