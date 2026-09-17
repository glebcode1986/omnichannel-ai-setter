import type { Logger } from "@omnichannel/observability";

/** Long-running background processors (BullMQ workers) owned by the runtime. */
export interface Processors {
  readonly queueNames: readonly string[];
  /** Resolves once running jobs have finished. */
  close(): Promise<void>;
}

export type WorkerRuntimeState = "idle" | "running" | "stopping" | "stopped";

export interface WorkerRuntime {
  readonly state: WorkerRuntimeState;
  /** Starts the long-running process. Throws if called more than once. */
  start(): void;
  /**
   * Gracefully stops the runtime. Idempotent: concurrent/repeated calls share one shutdown.
   * Background processors are closed (waiting for running jobs) before resolving.
   */
  stop(reason: string): Promise<void>;
}

export interface WorkerRuntimeOptions {
  logger: Logger;
  /** Starts the queue processors; omitted in lifecycle tests that need no Redis. */
  startProcessors?: () => Processors;
}

// Timers keep the Node.js event loop alive; the interval length itself is irrelevant.
const KEEP_ALIVE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Worker process lifecycle: starts the queue processors, stays alive, and on stop closes the processors
 * gracefully before releasing the process.
 */
export function createWorkerRuntime({ logger, startProcessors }: WorkerRuntimeOptions): WorkerRuntime {
  let state: WorkerRuntimeState = "idle";
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  let processors: Processors | undefined;
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
      processors = startProcessors?.();
      state = "running";
      logger.info("worker.started", {
        pid: process.pid,
        nodeVersion: process.version,
        queues: processors?.queueNames ?? [],
      });
    },

    stop(reason) {
      if (stopping) {
        return stopping;
      }
      const previousState = state;
      state = "stopping";
      // Deferred so a throwing shutdown step surfaces as a rejected promise, never a sync throw.
      stopping = Promise.resolve().then(async () => {
        logger.info("worker.stopping", { reason, previousState });
        await processors?.close();
        clearInterval(keepAlive);
        keepAlive = undefined;
        state = "stopped";
        logger.info("worker.stopped", { reason });
      });
      return stopping;
    },
  };
}
