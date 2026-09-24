import { EnvValidationError } from "@omnichannel/env";
import { createLogger } from "@omnichannel/observability";
import { createQueueWorkers, createRedisConnection } from "@omnichannel/queue";

import { loadWorkerEnv } from "./env";
import { processGuards } from "./process-guards";
import { createShutdownSequence } from "./shutdown";
import { createPlaceholderHandlers } from "./handlers";
import { createWorkerRuntime } from "./worker-runtime";

const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;
const SHUTDOWN_TIMEOUT_MS = 10_000;
/**
 * One Ctrl+C reaches the worker several times (terminal process group plus relays by pnpm/tsx), so
 * repeats within this window are the same request. A later signal while still stopping forces exit.
 */
const DUPLICATE_SIGNAL_WINDOW_MS = 2_000;

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
      const workers = createQueueWorkers({ connection, logger, handlers: createPlaceholderHandlers() });
      return {
        queueNames: workers.queueNames,
        async close() {
          await workers.close();
          await connection.quit().catch(() => connection.disconnect());
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
