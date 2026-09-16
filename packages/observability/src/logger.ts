export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** Returns a logger that adds `bindings` (e.g. `service`, `correlationId`) to every entry. */
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  /** Minimum level that is written; lower-severity entries are dropped. */
  level: LogLevel;
  /** Fields attached to every entry written by this logger and its children. */
  bindings?: LogFields;
  /** Receives one serialized JSON line per entry. Defaults to stdout (debug/info) and stderr (warn/error). */
  sink?: (line: string, level: LogLevel) => void;
  /** Clock used for the `time` field; injectable for deterministic tests. */
  now?: () => Date;
}

const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

const defaultSink = (line: string, level: LogLevel): void => {
  const stream = SEVERITY[level] >= SEVERITY.warn ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
};

/**
 * Structured JSON-lines logger. Core fields (`time`, `level`, `event`) always win over
 * caller-supplied fields so entries stay machine-parseable.
 */
export function createLogger(options: LoggerOptions): Logger {
  const sink = options.sink ?? defaultSink;
  const now = options.now ?? (() => new Date());
  const threshold = SEVERITY[options.level];
  const bindings = options.bindings ?? {};

  const write = (level: LogLevel, event: string, fields?: LogFields): void => {
    if (SEVERITY[level] < threshold) {
      return;
    }
    sink(serializeEntry({ ...bindings, ...fields, time: now().toISOString(), level, event }), level);
  };

  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
    child: (childBindings) =>
      createLogger({ ...options, bindings: { ...bindings, ...childBindings } }),
  };
}

function serializeEntry(entry: Record<string, unknown>): string {
  try {
    return JSON.stringify(entry, jsonReplacer());
  } catch (error) {
    // Never let a log call throw into business code; emit a minimal, still-valid entry instead.
    return JSON.stringify({
      time: entry.time,
      level: entry.level,
      event: entry.event,
      logSerializationError: error instanceof Error ? error.message : String(error),
    });
  }
}

function jsonReplacer(): (key: string, value: unknown) => unknown {
  const ancestors: unknown[] = [];
  return function (this: unknown, _key: string, value: unknown): unknown {
    if (typeof value === "bigint") {
      return value.toString();
    }
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack };
    }
    if (typeof value !== "object" || value === null) {
      return value;
    }
    // `this` is the object containing the current key; trim ancestors that are no longer on the path.
    while (ancestors.length > 0 && ancestors.at(-1) !== this) {
      ancestors.pop();
    }
    if (ancestors.includes(value)) {
      return "[Circular]";
    }
    ancestors.push(value);
    return value;
  };
}
