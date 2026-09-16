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
 * Primitive diagnostic properties copied from errors in addition to name/message/stack. Deliberately
 * an allowlist: HTTP/DB client errors often carry request config, headers or credentials.
 */
const ERROR_PRIMITIVE_FIELDS = ["code", "errno", "syscall", "address", "port"] as const;

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

const guardedStreams = new WeakSet<NodeJS.WriteStream>();

/**
 * A closed pipe (log collector restarted, `| head`) is reported asynchronously through the stream's
 * 'error' event, which would otherwise crash the process. Losing log output must not stop the
 * worker from finishing its jobs; any other stream error still surfaces.
 */
function guardStream(stream: NodeJS.WriteStream): void {
  if (guardedStreams.has(stream)) {
    return;
  }
  guardedStreams.add(stream);
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") {
      throw error;
    }
  });
}

const defaultSink = (line: string, level: LogLevel): void => {
  const stream = SEVERITY[level] >= SEVERITY.warn ? process.stderr : process.stdout;
  guardStream(stream);
  if (!stream.destroyed && stream.writable) {
    stream.write(`${line}\n`);
  }
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
      // A sink that throws synchronously must not take business code down with it.
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

function isError(value: unknown): value is Error {
  // Cross-realm safe (errors from vm contexts or worker threads are not `instanceof Error` here).
  return value instanceof Error || Object.prototype.toString.call(value) === "[object Error]";
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function describeNonError(value: unknown): unknown {
  return isPrimitive(value) ? value : `[non-error ${value === null ? "null" : typeof value}]`;
}

/**
 * Only name/message/stack, primitive diagnostic codes, and error-valued `cause`/`errors` are kept.
 * An error's own `toJSON` is ignored because it is where HTTP clients expose request config.
 */
function serializeError(error: Error): Record<string, unknown> {
  const record = error as unknown as Record<string, unknown>;
  const serialized: Record<string, unknown> = {
    name: typeof record.name === "string" ? record.name : "Error",
    message: typeof record.message === "string" ? record.message : "",
    stack: typeof record.stack === "string" ? record.stack : undefined,
  };
  for (const field of ERROR_PRIMITIVE_FIELDS) {
    if (isPrimitive(record[field])) {
      serialized[field] = record[field];
    }
  }
  if (record.cause !== undefined) {
    serialized.cause = isError(record.cause) ? record.cause : describeNonError(record.cause);
  }
  if (Array.isArray(record.errors)) {
    serialized.errors = record.errors.map((entry: unknown) => (isError(entry) ? entry : describeNonError(entry)));
  }
  return serialized;
}

function jsonReplacer(): (key: string, value: unknown) => unknown {
  const ancestors: unknown[] = [];
  return function (this: unknown, key: string, value: unknown): unknown {
    // JSON.stringify applies `toJSON` before calling the replacer; classify the raw property instead.
    const raw = key === "" || this === null || typeof this !== "object" ? value : (this as Record<string, unknown>)[key];
    const current = isError(raw) ? raw : value;

    if (typeof current === "bigint") {
      return current.toString();
    }
    if (typeof current !== "object" || current === null) {
      return current;
    }
    // `this` is the object containing the current key; trim ancestors that are no longer on the path.
    while (ancestors.length > 0 && ancestors.at(-1) !== this) {
      ancestors.pop();
    }
    if (ancestors.includes(current)) {
      return "[Circular]";
    }
    ancestors.push(current);
    if (isError(current)) {
      // Its children are visited with the serialized object as `this`, so track both.
      const serialized = serializeError(current);
      ancestors.push(serialized);
      return serialized;
    }
    return current;
  };
}
