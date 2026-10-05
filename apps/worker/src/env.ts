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

  /**
   * Meta app credentials, needed to sign and verify. The worker only sends, but the adapter is one object
   * and holds both halves.
   */
  INSTAGRAM_APP_SECRET: z.string().min(1).max(512).optional(),
  /** Same key the web app encrypts with; the worker only ever decrypts to send. */
  CHANNEL_CREDENTIAL_KEY_ID: z.string().min(1).max(64).optional(),
  CHANNEL_CREDENTIAL_KEY: z.base64().length(44).optional(),
  INSTAGRAM_VERIFY_TOKEN: z.string().min(1).max(512).optional(),
  /**
   * Whether Meta has approved this app for the Human Agent exception (ADR-014). Configuration rather than
   * a stored flag on an account, and `UNKNOWN` fails closed — which is the default on purpose.
   */
  INSTAGRAM_HUMAN_AGENT_APPROVAL: z.enum(["APPROVED", "NOT_APPROVED", "UNKNOWN"]).default("UNKNOWN"),

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
   * Transcription provider, for inbound voice notes (Issue #21).
   *
   * Optional for the same reason the embedding key is: without it a recording is recorded as unread and
   * the reply is held for a person, which is a supported configuration rather than a degraded one. A
   * missing key must never become a boot failure, and it must never become an invented transcript either.
   */
  OPENAI_API_KEY: z.string().min(1).max(512).optional(),
  /**
   * `gpt-transcribe` is the current recommended model and the documented replacement for `whisper-1`,
   * which was notified deprecated on 2026-08-26 and is removed from the API on 2027-02-27. Configurable
   * because a model name is a provider's decision on a provider's timetable, not ours.
   *
   * Note what changes with the model: `whisper-1` is the only one that reports any confidence signal at
   * all, and it reports it per segment through `verbose_json`. `gpt-transcribe` reports none, so a stored
   * transcript simply has no confidence — which the schema allows and nothing invents.
   */
  AI_TRANSCRIPTION_MODEL: z.string().min(1).max(128).default("gpt-transcribe"),
  /**
   * Largest recording this deployment will download, in megabytes.
   *
   * On top of the platform's own per-type limits rather than instead of them: WhatsApp allows 16 MB of
   * audio and the transcriber accepts 25 MB, and an operator may want less than either. The default is
   * the transcriber's own ceiling, so the binding limit is normally the platform's.
   */
  MEDIA_MAX_DOWNLOAD_MB: z.coerce.number().int().positive().max(100).default(25),
  /**
   * Whether a recording is deleted at the provider once its words are stored.
   *
   * `DELETE_AFTER_READING` is the privacy-preserving choice and is not the default, because deleting a
   * customer's recording is irreversible and a deployment should opt into it deliberately. `RETAIN` leaves
   * the provider's own thirty-day expiry to do it.
   */
  MEDIA_RETENTION: z.enum(["RETAIN", "DELETE_AFTER_READING"]).default("RETAIN"),
  /**
   * Graph API version for the media calls, matching the web app's.
   *
   * A deployment default rather than a constant: the provider deprecates a version after two years, and
   * moving with them must not need a release.
   */
  WHATSAPP_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/u).max(16).default("v26.0"),

  /**
   * Reliability controls (Issue #56).
   *
   * All four are tunable because the right values depend on the deployment rather than on the code: a
   * single-tenant install and a busy platform disagree about what a backlog is, and a generous grace
   * period on a quiet account is an hour of a customer waiting on a busy one.
   */
  RELIABILITY_STALE_CLAIM_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(120_000),
  /**
   * How long a send may stay unresolved before a person is told. Long enough that a late echo usually
   * settles it first; short enough that nobody believes a reply went out for an hour when it may not have.
   */
  RECONCILE_GRACE_MS: z.coerce.number().int().min(30_000).max(24 * 3_600_000).default(10 * 60_000),
  /** Waiting jobs at or above this level stop automated outbound until the pile drains. */
  BACKLOG_WAITING_LIMIT: z.coerce.number().int().min(10).max(100_000).default(500),
  /** Or an oldest job waiting this long, which catches a small queue that has stopped moving entirely. */
  BACKLOG_OLDEST_WAITING_MS: z.coerce.number().int().min(30_000).max(24 * 3_600_000).default(10 * 60_000),

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
