import { dispatchOutbox, MODEL_OUTPUT_SCHEMA_VERSION } from "@omnichannel/application";
import { createAnthropicReplyModel } from "@omnichannel/ai";
import {
  createAiDraftStore,
  createDbClient,
  createDraftContextStore,
  createIngestionStore,
  createStyleProfileStore,
} from "@omnichannel/db";
import { EnvValidationError } from "@omnichannel/env";
import { resolveStyleProfile } from "@omnichannel/domain";
import { createLogger } from "@omnichannel/observability";
import { createQueueProducer, createQueueWorkers, createRedisConnection } from "@omnichannel/queue";

import { loadWorkerEnv } from "./env";
import { randomUUID } from "node:crypto";

import { createAiDraftHandler } from "./ai-draft-handler";
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
        styleProfiles: createStyleProfileStore(db),
        platformStyleFallback: resolveStyleProfile([{ persona: env.AI_PERSONA }]),
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
