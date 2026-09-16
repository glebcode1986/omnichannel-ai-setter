import type { Logger } from "@omnichannel/observability";

export type WorkerRuntimeState = "idle" | "running" | "stopping" | "stopped";

export interface WorkerRuntime {
  readonly state: WorkerRuntimeState;
  /** Starts the long-running process. Throws if called more than once. */
  start(): void;
  /**
   * Gracefully stops the runtime. Idempotent: concurrent/repeated calls share one shutdown.
   * Background processors (BullMQ workers from #5) will be closed here before resolving.
   */
  stop(reason: string): Promise<void>;
}

export interface WorkerRuntimeOptions {
  logger: Logger;
}

// Timers keep the Node.js event loop alive; the interval length itself is irrelevant.
const KEEP_ALIVE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Minimal worker process lifecycle for the Phase 1 scaffold. It owns no product logic yet:
 * it only stays alive until asked to stop, which gives #5 a composition point for queue processors.
 */
export function createWorkerRuntime({ logger }: WorkerRuntimeOptions): WorkerRuntime {
  let state: WorkerRuntimeState = "idle";
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  let stopping: Promise<void> | undefined;

  return {
    get state() {
      return state;
    },

    start() {
      if (state !== "idle") {
        throw new Error(`Worker runtime cannot start from state "${state}".`);
      }
      keepAlive = setInterval(() => undefined, KEEP_ALIVE_INTERVAL_MS);
      state = "running";
      logger.info("worker.started", { pid: process.pid, nodeVersion: process.version });
    },

    stop(reason) {
      if (stopping) {
        return stopping;
      }
      const previousState = state;
      state = "stopping";
      // Deferred so a throwing shutdown step surfaces as a rejected promise, never a sync throw.
      stopping = Promise.resolve().then(() => {
        logger.info("worker.stopping", { reason, previousState });
        // #5: await queue processor close() calls here, before releasing the keep-alive handle.
        clearInterval(keepAlive);
        keepAlive = undefined;
        state = "stopped";
        logger.info("worker.stopped", { reason });
      });
      return stopping;
    },
  };
}
