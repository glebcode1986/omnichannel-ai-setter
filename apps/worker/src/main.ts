import { EnvValidationError } from "@omnichannel/env";
import { createLogger } from "@omnichannel/observability";

import { loadWorkerEnv } from "./env";
import { createWorkerRuntime } from "./worker-runtime";

const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;
const SHUTDOWN_TIMEOUT_MS = 10_000;

function main(): void {
  let env;
  try {
    env = loadWorkerEnv();
  } catch (error) {
    const bootLogger = createLogger({ level: "error", bindings: { service: "worker" } });
    bootLogger.error("worker.env_invalid", {
      issues: error instanceof EnvValidationError ? error.issues : undefined,
      error: error instanceof EnvValidationError ? undefined : error,
    });
    process.exitCode = 1;
    return;
  }

  const logger = createLogger({ level: env.LOG_LEVEL, bindings: { service: "worker" } });
  const runtime = createWorkerRuntime({ logger });

  process.on("uncaughtException", (error, origin) => {
    logger.error("worker.fatal", { error, origin });
    process.exit(1);
  });

  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, () => {
      if (runtime.state === "stopping" || runtime.state === "stopped") {
        logger.warn("worker.forced_exit", { signal });
        process.exit(1);
      }

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
    });
  }

  runtime.start();
}

main();
