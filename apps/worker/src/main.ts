import { dispatchOutbox, MODEL_OUTPUT_SCHEMA_VERSION } from "@omnichannel/application";
import { createAnthropicReplyModel, createVoyageEmbeddingProvider } from "@omnichannel/ai";
import {
  createAiDraftStore,
  createDbClient,
  createDraftContextStore,
  createIngestionStore,
  createKnowledgeRetriever,
  createStyleRetriever,
  EMBEDDING_DIMENSIONS,
} from "@omnichannel/db";
import { EnvValidationError } from "@omnichannel/env";
import { createLogger, type Logger } from "@omnichannel/observability";
import { createQueueProducer, createQueueWorkers, createRedisConnection } from "@omnichannel/queue";

import { loadWorkerEnv, type WorkerEnv } from "./env";
import { randomUUID } from "node:crypto";

import { createAiDraftHandler } from "./ai-draft-handler";
import { createHandlers } from "./handlers";
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
 * A configured width that disagrees with the `vector(N)` column can never match a stored vector, so every
 * semantic query would fail and every draft would be held for review. That is a configuration mistake, and
 * it is caught here — but it does not stop the worker: taking ingestion down over a retrieval setting would
 * turn a degraded feature into an outage. Lexical-only is a supported mode, so it runs in that mode and
 * says so loudly.
 */
function createEmbeddings(env: WorkerEnv, logger: Logger) {
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
        retrieval: {
          knowledge: createKnowledgeRetriever(db),
          style: createStyleRetriever(db),
          ...(embeddings === undefined ? {} : { embeddings }),
          log: logger,
        },
        persona: env.AI_PERSONA,
        logger,
      });
      const workers = createQueueWorkers({ connection, logger, handlers: createHandlers(generateDraft) });
      const producer = createQueueProducer({ connection, logger });
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

  process.on("uncaughtException", (error, origin) => {
    logger.error("worker.fatal", { error, origin });
    process.exit(1);
  });

  let firstSignalAt: number | undefined;
  const onShutdownSignal = (signal: (typeof SHUTDOWN_SIGNALS)[number]): void => {
    if (firstSignalAt === undefined) {
      firstSignalAt = Date.now();
      // Guard against a processor that never finishes closing; unref so it cannot keep us alive.
      setTimeout(() => {
        logger.error("worker.shutdown_timeout", { signal, timeoutMs: SHUTDOWN_TIMEOUT_MS });
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS).unref();

      runtime.stop(signal).then(
        () => {
          process.exitCode = 0;
        },
        (error: unknown) => {
          logger.error("worker.shutdown_failed", { signal, error });
          process.exit(1);
        },
      );
      return;
    }

    if (Date.now() - firstSignalAt < DUPLICATE_SIGNAL_WINDOW_MS) {
      logger.debug("worker.duplicate_signal_ignored", { signal });
      return;
    }
    // A deliberate later signal: either shutdown is slow, or it finished but a leaked handle keeps
    // the process alive. Either way the operator asked twice, so exit now.
    logger.warn(runtime.state === "stopped" ? "worker.lingering_after_stop" : "worker.forced_exit", { signal });
    process.exit(1);
  };

  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, onShutdownSignal);
  }

  runtime.start();
}

main();
