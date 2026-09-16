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

/** Core fields are always set by the logger and cannot be overridden by bindings or fields. */
const CORE_FIELDS = new Set(["time", "level", "event"]);

/**
 * Diagnostic properties copied from errors in addition to name/message/stack. Deliberately an
 * allowlist: HTTP/DB client errors often carry request config, headers or credentials.
 */
const ERROR_DIAGNOSTIC_FIELDS = ["code", "errno", "syscall", "address", "port", "cause", "errors"] as const;

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

const defaultSink = (line: string, level: LogLevel): void => {
  const stream = SEVERITY[level] >= SEVERITY.warn ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
};

/**
 * Structured JSON-lines logger. Core fields (`time`, `level`, `event`) always win over
 * caller-supplied fields, and a log call never throws into the caller.
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
    let line: string;
    try {
      line = JSON.stringify(buildEntry(level, event, now(), bindings, fields), jsonReplacer());
    } catch (error) {
      line = JSON.stringify({
        time: new Date().toISOString(),
        level,
        event,
        logSerializationError: error instanceof Error ? `${error.name}: ${error.message}` : "unknown error",
      });
    }
    try {
      sink(line, level);
    } catch {
      // A broken sink (e.g. closed stdout pipe) must not take business code down with it.
    }
  };

  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
    child: (childBindings) => createLogger({ ...options, bindings: { ...bindings, ...childBindings } }),
  };
}

function buildEntry(
  level: LogLevel,
  event: string,
  time: Date,
  bindings: LogFields,
  fields: LogFields | undefined,
): Record<string, unknown> {
  // Null prototype: a `__proto__` field becomes a plain property instead of changing the prototype.
  const entry = Object.create(null) as Record<string, unknown>;
  for (const source of [bindings, fields ?? {}]) {
    for (const key of Object.keys(source)) {
      // An own `toJSON` would replace the whole entry during JSON.stringify.
      if (!CORE_FIELDS.has(key) && key !== "toJSON") {
        entry[key] = source[key];
      }
    }
  }
  entry.time = time.toISOString();
  entry.level = level;
  entry.event = event;
  return entry;
}

function serializeError(error: Error): Record<string, unknown> {
  const serialized: Record<string, unknown> = { name: error.name, message: error.message, stack: error.stack };
  const record = error as unknown as Record<string, unknown>;
  for (const field of ERROR_DIAGNOSTIC_FIELDS) {
    if (record[field] !== undefined) {
      serialized[field] = record[field];
    }
  }
  return serialized;
}

function jsonReplacer(): (key: string, value: unknown) => unknown {
  const ancestors: unknown[] = [];
  return function (this: unknown, _key: string, value: unknown): unknown {
    if (typeof value === "bigint") {
      return value.toString();
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
    if (value instanceof Error) {
      // Its children are visited with the serialized object as `this`, so track both.
      const serialized = serializeError(value);
      ancestors.push(serialized);
      return serialized;
    }
    return value;
  };
}
