/**
 * What the worker does when an error escapes every handler (Issue #5).
 *
 * The two cases are treated differently on purpose, and the difference is the whole point of this file.
 *
 * An **uncaught exception** interrupted a synchronous stack part-way through. What it was doing at the
 * time is unknown, so the process stops: continuing on unknown invariants is how a worker corrupts the
 * thing it was writing.
 *
 * An **unhandled rejection** is fatal too, with exactly one exemption, and the exemption is the point.
 *
 * A rejection can escape after a partial write, and continuing then means processing policy-critical work
 * on invariants nobody can vouch for. So "a promise failed, carry on" is the wrong default: unknown cause
 * means stop, as everywhere else in this system.
 *
 * The one exception is a failure this worker can positively identify as its own Redis client reconnecting
 * during an outage it is already in — see `redis-outage.ts` for how narrowly that is decided. That case is
 * survived because the alternative is a crash loop during the outage the worker exists to ride out, and
 * because the rejection comes from a socket that never carried a write.
 *
 * Both are logged as errors either way: a rejection nobody awaited is a bug even when it is survivable.
 *
 * Neither log carries the error itself. An error object serializes its message and its stack, and a
 * connection failure's message contains the host, the user and sometimes the password — a crash log is
 * exactly where that ends up being read by everyone.
 */
import type { Logger } from "@omnichannel/observability";

/**
 * The handlers, built rather than installed.
 *
 * `process` is never passed in as a value: the architecture checker refuses a runtime global used that
 * way, because it cannot follow what a module might do with one. So the composition root does the
 * wiring with two literal `process.on` calls, and everything worth testing lives in here.
 */
export interface ProcessGuards {
  /** Arrow-typed rather than methods: these are handed straight to `process.on` and lose their object. */
  readonly onUncaughtException: (error: unknown, origin: string) => void;
  readonly onUnhandledRejection: (reason: unknown) => void;
}

export interface ProcessGuardOptions {
  readonly logger: Logger;
  readonly exit: (code: number) => void;
  /**
   * Decides whether an escaped rejection is the one known survivable case. Default: nothing is, which is
   * the correct answer for anything that has not positively identified itself.
   */
  readonly survivable?: (reason: unknown) => boolean;
}

export function processGuards({ logger, exit, survivable = () => false }: ProcessGuardOptions): ProcessGuards {
  return {
    onUncaughtException: (error, origin) => {
      logger.error("worker.fatal", { errorName: nameOf(error), ...codeOf(error), origin });
      exit(1);
    },

    onUnhandledRejection: (reason) => {
      if (survivable(reason)) {
        logger.error("worker.unhandled_rejection", { errorName: nameOf(reason), ...codeOf(reason), survived: true });
        return;
      }
      // Unknown cause, so unknown state. Stop, exactly as for an uncaught exception.
      logger.error("worker.fatal", { errorName: nameOf(reason), ...codeOf(reason), origin: "unhandledRejection" });
      exit(1);
    },
  };
}

/** The error's class only. Never its message, which routinely carries hosts, URLs and credentials. */
function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** A provider's own error code when it is a plain scalar; anything richer is not worth the risk. */
function codeOf(error: unknown): { readonly errorCode?: string } {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" || typeof code === "number" ? { errorCode: String(code) } : {};
}
