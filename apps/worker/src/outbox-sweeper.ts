import type { OutboxDispatchResult } from "@omnichannel/application";
import type { Logger } from "@omnichannel/observability";

export interface OutboxSweeper {
  /** Stops scheduling sweeps and waits for a running sweep to finish. */
  close(): Promise<void>;
}

export interface OutboxSweeperOptions {
  readonly intervalMs: number;
  readonly sweep: () => Promise<OutboxDispatchResult>;
  readonly logger: Logger;
}

/**
 * Recovery loop for the transactional outbox: webhook ingestion dispatches entries right after commit,
 * and this loop enqueues anything that failed or was interrupted. Sweeps never overlap, and failures are
 * logged once per outage.
 */
export function startOutboxSweeper({ intervalMs, sweep, logger }: OutboxSweeperOptions): OutboxSweeper {
  let closed = false;
  let failing = false;
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = () => {
    if (!closed) {
      timer = setTimeout(run, intervalMs);
    }
  };

  function run(): void {
    running = sweep().then(
      (result) => {
        if (failing) {
          failing = false;
          logger.info("worker.outbox_sweep_recovered");
        }
        if (result.dispatched > 0 || result.failed > 0) {
          logger.info("worker.outbox_swept", { ...result });
        }
      },
      (error: unknown) => {
        if (!failing) {
          failing = true;
          logger.warn("worker.outbox_sweep_failed", { errorName: error instanceof Error ? error.name : typeof error });
        }
      },
    );
    void running.finally(schedule);
  }

  schedule();
  return {
    async close() {
      closed = true;
      clearTimeout(timer);
      await running;
    },
  };
}
