/**
 * What happens between the first stop signal and the process actually going away (Issue #5).
 *
 * The sequence looks small and is not: it has to collapse the three SIGINTs one Ctrl+C produces, give a
 * slow processor a bounded chance to finish, and then decide what the process's exit code says to whoever
 * is supervising it. That decision was the one thing here with no test, and it was wrong in a way that
 * only showed up under load.
 *
 * **A deadline that fires is two different situations.** Either the close is still running — processors
 * that have not finished, and nobody can say what state they are in, so the process stops and reports
 * failure — or the close *finished* and something a library owns kept a handle open afterwards. The
 * second is not a failed shutdown: every queue was closed, every connection was told to quit, and the
 * work is done. Reporting failure there tells a supervisor to treat a clean stop as a crash, and it hides
 * the genuine case behind noise.
 *
 * The two are now distinguished by the runtime's own state and say so in the log, so the next occurrence
 * names which one it was instead of leaving it to be guessed at.
 */
import type { Logger } from "@omnichannel/observability";

import type { WorkerRuntime } from "./worker-runtime";

export interface ShutdownOptions {
  readonly runtime: Pick<WorkerRuntime, "state" | "stop">;
  readonly logger: Logger;
  readonly exit: (code: number) => void;
  readonly setExitCode: (code: number) => void;
  readonly now: () => number;
  /** Schedules the deadline. Injected so a test fires it instead of waiting ten seconds for it. */
  readonly schedule: (ms: number, run: () => void) => void;
  readonly timeoutMs: number;
  /**
   * One Ctrl+C reaches the worker several times (the terminal's process group, plus relays by pnpm and
   * watchers), so repeats inside this window are the same request rather than an operator insisting.
   */
  readonly duplicateWindowMs: number;
}

export function createShutdownSequence(options: ShutdownOptions): (signal: string) => void {
  const { runtime, logger, exit, setExitCode, now, schedule, timeoutMs, duplicateWindowMs } = options;
  let firstSignalAt: number | undefined;

  /** Whether the close finished, whatever else is still holding the process open. */
  const stopped = (): boolean => runtime.state === "stopped";

  return function onSignal(signal: string): void {
    if (firstSignalAt === undefined) {
      firstSignalAt = now();

      schedule(timeoutMs, () => {
        if (stopped()) {
          // Everything closed and the process is still here, so a handle outlived its owner. The work is
          // done, and a supervisor that restarts on a non-zero code must not be told otherwise — but a
          // process its own deadline had to kill is still abnormal, so this stays above the info line
          // where anyone filtering logs will see it.
          logger.warn("worker.lingering_after_stop", { signal, timeoutMs, trigger: "deadline" });
          exit(0);
          return;
        }
        // Still closing. What the processors were part-way through is unknown, which is the one case
        // worth reporting as a failure.
        logger.error("worker.shutdown_timeout", { signal, timeoutMs, state: runtime.state });
        exit(1);
      });

      runtime.stop(signal).then(
        () => {
          // Not `exit(0)`: the event loop is allowed to drain on its own, so a final log line or a
          // socket's last write is not cut off. The deadline above is what bounds the wait.
          setExitCode(0);
        },
        (error: unknown) => {
          // The error's class only. Its message carries hosts and, for a connection failure, credentials.
          logger.error("worker.shutdown_failed", { signal, errorName: error instanceof Error ? error.name : typeof error });
          exit(1);
        },
      );
      return;
    }

    if (now() - firstSignalAt < duplicateWindowMs) {
      logger.debug("worker.duplicate_signal_ignored", { signal });
      return;
    }

    if (stopped()) {
      // A deliberate second signal against a process that has already finished closing: the operator is
      // asking it to go away, not reporting a failure, so it goes away successfully.
      logger.warn("worker.lingering_after_stop", { signal, trigger: "signal" });
      exit(0);
      return;
    }
    logger.warn("worker.forced_exit", { signal, state: runtime.state });
    exit(1);
  };
}
