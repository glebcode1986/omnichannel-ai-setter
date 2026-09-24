/**
 * What the worker does when an error escapes every handler (Issue #5).
 *
 * The two cases are treated differently on purpose, and the difference is the whole point of this file.
 *
 * An **uncaught exception** interrupted a synchronous stack part-way through. What it was doing at the
 * time is unknown, so the process stops: continuing on unknown invariants is how a worker corrupts the
 * thing it was writing.
 *
 * An **unhandled rejection** is fatal for the same reason, and there is no exemption here.
 *
 * A rejection can escape after a partial write, and continuing then means processing policy-critical work
 * on invariants nobody can vouch for. Nothing at this level can tell one escaped rejection from another:
 * an error code and a dependency's current state are circumstantial, and two unrelated failures can share
 * both. Guessing from them would excuse the case it was written for and, sooner or later, a different one
 * that merely looked the same.
 *
 * A reconnect failure that genuinely may be survived is contained where it is produced — by the client or
 * emitter that owns it — and then it never reaches here. Anything that does reach here is, by definition,
 * a failure nobody could attribute, and the worker stops so its supervisor can start it clean.
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
}

export function processGuards({ logger, exit }: ProcessGuardOptions): ProcessGuards {
  return {
    onUncaughtException: (error, origin) => {
      logger.error("worker.fatal", { errorName: nameOf(error), ...codeOf(error), origin });
      exit(1);
    },

    onUnhandledRejection: (reason) => {
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
