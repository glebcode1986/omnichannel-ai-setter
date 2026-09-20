/**
 * A periodic task that must not overlap itself and must not shout during an outage.
 *
 * Both properties matter more than they look. Overlapping runs of a sweeper would have two passes
 * claiming the same rows, and a loop that logs every failed tick turns a five-minute database outage into
 * thousands of identical lines — the same alert-fatigue failure the incident aggregation exists to
 * prevent, arriving through the log instead.
 */
import type { Logger } from "@omnichannel/observability";

export interface RecoveryLoop {
  /** Stops scheduling ticks and waits for one already running to finish. */
  close(): Promise<void>;
}

export interface RecoveryLoopOptions {
  readonly name: string;
  readonly intervalMs: number;
  /** Returns fields worth logging, or undefined when the tick found nothing to do. */
  readonly tick: () => Promise<Readonly<Record<string, unknown>> | undefined>;
  readonly logger: Logger;
}

export function startRecoveryLoop({ name, intervalMs, tick, logger }: RecoveryLoopOptions): RecoveryLoop {
  let closed = false;
  let failing = false;
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (): void => {
    if (!closed) {
      timer = setTimeout(run, intervalMs);
    }
  };

  function run(): void {
    running = tick().then(
      (fields) => {
        if (failing) {
          failing = false;
          logger.info(`worker.${name}_recovered`);
        }
        if (fields !== undefined) {
          logger.info(`worker.${name}`, fields);
        }
      },
      (error: unknown) => {
        if (!failing) {
          failing = true;
          // The error's name only: a sweeper failure during an outage is exactly where a connection
          // string ends up in a log.
          logger.warn(`worker.${name}_failed`, { errorName: error instanceof Error ? error.name : typeof error });
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
