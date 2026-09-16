import { EnvValidationError } from "@omnichannel/env";
import { createLogger } from "@omnichannel/observability";

import { loadWorkerEnv } from "./env";
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
  const runtime = createWorkerRuntime({ logger });

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

    if (runtime.state === "stopped" || Date.now() - firstSignalAt < DUPLICATE_SIGNAL_WINDOW_MS) {
      logger.debug("worker.duplicate_signal_ignored", { signal });
      return;
    }
    logger.warn("worker.forced_exit", { signal });
    process.exit(1);
  };

  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, onShutdownSignal);
  }

  runtime.start();
}

main();
