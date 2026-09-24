import { dispatchOutbox, MODEL_OUTPUT_SCHEMA_VERSION } from "@omnichannel/application";
import { createAnthropicReplyModel } from "@omnichannel/ai";
import {
  createAiDraftStore,
  createDbClient,
  createDraftContextStore,
  createIngestionStore,
  createKnowledgeRetriever,
  createStyleProfileStore,
  createDeliveryStore,
  createCredentialCipher,
  createStyleRetriever,
} from "@omnichannel/db";
import { EnvValidationError } from "@omnichannel/env";
import { resolveStyleProfile } from "@omnichannel/domain";
import { createLogger, type Logger } from "@omnichannel/observability";
import { createQueueProducer, createQueueWorkers, createRedisConnection } from "@omnichannel/queue";

import { createEmbeddings } from "./embeddings";
import { loadWorkerEnv, type WorkerEnv } from "./env";
import { randomUUID } from "node:crypto";

import { createAiDraftHandler } from "./ai-draft-handler";
import type { DeliverySendPort } from "@omnichannel/application";

import { createDebounceHandler } from "./debounce-handler";
import { createInstagramDeliverySender } from "./instagram-sender";
import { createDeliveryHandler } from "./delivery-handler";
import { createDraftDisposition } from "./draft-disposition";
import { createDeliveryPolicyResolver } from "./delivery-policy";
import { createHandlers } from "./handlers";
import { processGuards } from "./process-guards";
import { createShutdownSequence } from "./shutdown";
import { startOutboxSweeper } from "./outbox-sweeper";
import { createWorkerRuntime } from "./worker-runtime";

const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const OUTBOX_SWEEP_INTERVAL_MS = 5_000;
/**
 * One Ctrl+C reaches the worker several times (terminal process group plus relays by pnpm/tsx), so
 * repeats within this window are the same request. A later signal while still stopping forces exit.
 */
const DUPLICATE_SIGNAL_WINDOW_MS = 2_000;
/** Bumped whenever the prompt changes, and persisted with every draft so output stays attributable. */
const PROMPT_VERSION = "reply.v1";

/**
 * Without Meta app credentials there is no adapter, and delivery refuses with a named reason rather than
 * pretending: a rejection that says why is safe, and an accepted send that never happened would not be.
 */
function createSender(env: WorkerEnv, db: ReturnType<typeof createDbClient>, logger: Logger): DeliverySendPort {
  if (env.INSTAGRAM_APP_SECRET === undefined || env.INSTAGRAM_VERIFY_TOKEN === undefined || env.CHANNEL_CREDENTIAL_KEY_ID === undefined || env.CHANNEL_CREDENTIAL_KEY === undefined) {
    logger.warn("worker.no_channel_adapter", { reason: "instagram app or credential-encryption configuration is missing" });
    return {
      send: () => Promise.resolve({ outcome: "REJECTED", retryable: false, code: "NO_ADAPTER", message: "no channel adapter is configured for delivery" }),
    };
  }
  return createInstagramDeliverySender({
    db,
    cipher: createCredentialCipher({ keyId: env.CHANNEL_CREDENTIAL_KEY_ID, keys: { [env.CHANNEL_CREDENTIAL_KEY_ID]: Buffer.from(env.CHANNEL_CREDENTIAL_KEY, "base64") } }),
    appSecret: env.INSTAGRAM_APP_SECRET,
    verifyToken: env.INSTAGRAM_VERIFY_TOKEN,
    humanAgentApproval: env.INSTAGRAM_HUMAN_AGENT_APPROVAL,
    logger,
  });
}

function main(): void {
  let env;
  try {
    env = loadWorkerEnv();
  } catch (error) {
    const bootLogger = createLogger({ level: "error", bindings: { service: "worker" } });
    bootLogger.error("worker.env_invalid", {
      // EnvValidationError is value-free by construction; anything else is reduced to its name
      // because an unexpected error message could quote a configuration value.
      ...(error instanceof EnvValidationError
        ? { issues: error.issues }
        : { errorName: error instanceof Error ? error.name : typeof error }),
    });
    process.exitCode = 1;
    return;
  }

  const logger = createLogger({ level: env.LOG_LEVEL, bindings: { service: "worker" } });
  const runtime = createWorkerRuntime({
    logger,
    startProcessors: () => {
      const connection = createRedisConnection(env.REDIS_URL, "worker", logger);
      const db = createDbClient({ connectionString: env.DATABASE_URL });
      // Provider choice is configuration: the model ID and key come from the validated environment, and
      // nothing below this line knows which provider is in use.
      const replyModel = createAnthropicReplyModel({
        apiKey: env.ANTHROPIC_API_KEY,
        model: env.AI_REPLY_MODEL,
        maxOutputTokens: env.AI_REPLY_MAX_OUTPUT_TOKENS,
        logger,
      });
      // No embeddings key means lexical-only retrieval, which is supported: retrieval still runs and a
      // fact it misses becomes MISSING_FACT and human review rather than an invented answer.
      const embeddings = createEmbeddings(env, logger);
      // Stated at boot, not inferred from silence: lexical-only is a supported mode, but an operator has
      // to be able to see which mode a worker is actually in before a customer asks a factual question.
      logger.info("worker.retrieval_mode", { semantic: embeddings !== undefined, lexical: true });
      const producer = createQueueProducer({ connection, logger });
      const generateDraft = createAiDraftHandler({
        engine: {
          model: replyModel,
          drafts: createAiDraftStore(db),
          log: logger,
          now: () => new Date(),
          newNonce: randomUUID,
          promptVersion: PROMPT_VERSION,
          schemaVersion: MODEL_OUTPUT_SCHEMA_VERSION,
          timeoutMs: env.AI_REPLY_TIMEOUT_MS,
        },
        context: createDraftContextStore(db),
        dispose: createDraftDisposition({ db, producer, logger, now: () => new Date(), random: Math.random }),
        retrieval: {
          knowledge: createKnowledgeRetriever(db),
          style: createStyleRetriever(db),
          ...(embeddings === undefined ? {} : { embeddings }),
          log: logger,
        },
        styleProfiles: createStyleProfileStore(db),
        platformStyleFallback: resolveStyleProfile([{ persona: env.AI_PERSONA }]),
        logger,
      });
      const deliver = createDeliveryHandler({
        engine: {
          store: createDeliveryStore(db),
          sender: createSender(env, db, logger),
          log: logger,
          now: () => new Date(),
        },
        conversationPolicy: createDeliveryPolicyResolver(db, () => new Date()),
        logger,
      });
      const workers = createQueueWorkers({
        connection,
        logger,
        handlers: createHandlers(generateDraft, deliver, createDebounceHandler({ producer, logger })),
      });
      const sweeper = startOutboxSweeper({
        intervalMs: OUTBOX_SWEEP_INTERVAL_MS,
        sweep: () =>
          dispatchOutbox({ store: createIngestionStore(db), scheduler: producer, log: logger, now: () => new Date() }),
        logger,
      });
      return {
        queueNames: workers.queueNames,
        async close() {
          await sweeper.close();
          await workers.close();
          await producer.close();
          await connection.quit().catch(() => connection.disconnect());
          await db.$disconnect();
        },
      };
    },
  });

  const guards = processGuards({
    logger,
    exit: (code) => {
      process.exit(code);
    },
  });
  process.on("uncaughtException", guards.onUncaughtException);
  process.on("unhandledRejection", guards.onUnhandledRejection);

  const onShutdownSignal = createShutdownSequence({
    runtime,
    logger,
    exit: (code) => {
      process.exit(code);
    },
    setExitCode: (code) => {
      process.exitCode = code;
    },
    now: () => Date.now(),
    schedule: (ms, run) => {
      // Unref'd: the deadline bounds the wait, it must never be the reason the process is still alive.
      setTimeout(run, ms).unref();
    },
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
    duplicateWindowMs: DUPLICATE_SIGNAL_WINDOW_MS,
  });

  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, onShutdownSignal);
  }

  runtime.start();
}

main();
