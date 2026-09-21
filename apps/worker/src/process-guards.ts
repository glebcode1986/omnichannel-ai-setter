/**
 * What the worker does when an error escapes every handler (Issue #5).
 *
 * The two cases are treated differently on purpose, and the difference is the whole point of this file.
 *
 * An **uncaught exception** interrupted a synchronous stack part-way through. What it was doing at the
 * time is unknown, so the process stops: continuing on unknown invariants is how a worker corrupts the
 * thing it was writing.
 *
 * An **unhandled rejection** is not that. Nothing was interrupted — a promise nobody awaited failed, so
 * the work it belonged to is lost and no invariant was left half-applied, because every durable write in
 * this system is a transaction or a conditional update. Meanwhile the shape this actually takes in
 * production is a background reconnect to a Redis that is down, which is precisely the outage this worker
 * is built to run through. Node's default promotes such a rejection to a fatal, which would turn a
 * dependency outage into a crash loop at the moment recovery matters most, and take every in-flight job
 * with it.
 *
 * It is still an error and still logged as one: a rejection nobody awaited is a bug even when it is
 * survivable, and it should be visible without being terminal.
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

export function processGuards(logger: Logger, exit: (code: number) => void): ProcessGuards {
  return {
    onUncaughtException: (error, origin) => {
      logger.error("worker.fatal", { errorName: nameOf(error), ...codeOf(error), origin });
      exit(1);
    },

    onUnhandledRejection: (reason) => {
      logger.error("worker.unhandled_rejection", { errorName: nameOf(reason), ...codeOf(reason) });
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
