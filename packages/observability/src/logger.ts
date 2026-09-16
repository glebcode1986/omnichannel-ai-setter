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
      line = JSON.stringify(buildEntry(level, event, now(), bindings, fields));
    } catch {
      // Fixed text only: an exception raised by caller data may itself carry secrets.
      line = JSON.stringify({ time: new Date().toISOString(), level, event, logSerializationError: UNSERIALIZABLE });
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

const UNSERIALIZABLE = "[unserializable]";
const MAX_DEPTH = 32;

/** Reads a property without letting a throwing getter or proxy trap escape. */
function readProperty(source: object, key: PropertyKey): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: (source as Record<PropertyKey, unknown>)[key] };
  } catch {
    return { ok: false };
  }
}

function buildEntry(
  level: LogLevel,
  event: string,
  time: Date,
  bindings: LogFields,
  fields: LogFields | undefined,
): Record<string, unknown> {
  // Null prototype: a `__proto__` field becomes a plain property instead of changing the prototype.
  const raw = Object.create(null) as Record<string, unknown>;
  for (const source of [bindings, fields ?? {}]) {
    for (const key of Object.keys(source)) {
      // An own `toJSON` would replace the whole entry during JSON.stringify.
      if (!CORE_FIELDS.has(key) && key !== "toJSON") {
        const read = readProperty(source, key);
        raw[key] = read.ok ? read.value : UNSERIALIZABLE;
      }
    }
  }
  const entry = toJsonSafe(raw, [], 0) as Record<string, unknown>;
  entry.time = time.toISOString();
  entry.level = level;
  entry.event = event;
  return entry;
}

const nativeIsError = (Error as { isError?: (value: unknown) => boolean }).isError;

/**
 * Error detection that also covers other realms (vm contexts), subclasses with a custom
 * `Symbol.toStringTag` and proxies: anything branded as an error or exposing string
 * `message` + `stack` is serialized through the error allowlist, never through its own toJSON.
 */
function isError(value: unknown): value is Error {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  try {
    if (value instanceof Error || nativeIsError?.(value) === true || Object.prototype.toString.call(value) === "[object Error]") {
      return true;
    }
  } catch {
    // A revoked proxy or hostile getPrototypeOf trap: fall through to the structural check.
  }
  // Prototype chain of another realm (or seen through a proxy): look for an `Error` constructor.
  try {
    let prototype: unknown = Object.getPrototypeOf(value);
    for (let hops = 0; prototype !== null && typeof prototype === "object" && hops < 16; hops += 1) {
      const constructor = readProperty(prototype, "constructor");
      if (constructor.ok && typeof constructor.value === "function" && constructor.value.name === "Error") {
        return true;
      }
      prototype = Object.getPrototypeOf(prototype);
    }
  } catch {
    // Hostile getPrototypeOf trap: fall through to the structural check.
  }
  const message = readProperty(value, "message");
  const stack = readProperty(value, "stack");
  return message.ok && stack.ok && typeof message.value === "string" && typeof stack.value === "string";
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/**
 * Only name/message/stack, primitive diagnostic codes, and error-valued `cause`/`errors` are kept.
 * Nothing on the error is invoked: its own `toJSON` (where HTTP clients expose request config) is
 * never called, and throwing getters yield a fixed placeholder.
 */
function serializeError(error: Error, ancestors: unknown[], depth: number): Record<string, unknown> {
  const serialized = Object.create(null) as Record<string, unknown>;
  const text = (key: string, fallback?: string) => {
    const read = readProperty(error, key);
    return read.ok ? (typeof read.value === "string" ? read.value : fallback) : UNSERIALIZABLE;
  };
  serialized.name = text("name", "Error");
  serialized.message = text("message", "");
  const stack = text("stack");
  if (stack !== undefined) {
    serialized.stack = stack;
  }
  for (const field of ERROR_PRIMITIVE_FIELDS) {
    const read = readProperty(error, field);
    if (!read.ok) {
      serialized[field] = UNSERIALIZABLE;
    } else if (isPrimitive(read.value)) {
      serialized[field] = read.value;
    }
  }
  const cause = readProperty(error, "cause");
  if (!cause.ok) {
    serialized.cause = UNSERIALIZABLE;
  } else if (cause.value !== undefined) {
    serialized.cause = isError(cause.value) ? toJsonSafe(cause.value, ancestors, depth + 1) : describeNonError(cause.value);
  }
  const errors = readProperty(error, "errors");
  if (!errors.ok) {
    serialized.errors = UNSERIALIZABLE;
  } else if (Array.isArray(errors.value)) {
    serialized.errors = copyArray(errors.value, (entry) =>
      isError(entry) ? toJsonSafe(entry, ancestors, depth + 1) : describeNonError(entry),
    );
  }
  return serialized;
}

/**
 * Index loop into a fresh array: `Array.prototype.map` follows `Symbol.species`, which lets a caller
 * substitute an arbitrary object (even an error with a toJSON) for the sanitized copy.
 */
function copyArray(source: readonly unknown[], convert: (entry: unknown) => unknown): unknown[] {
  const lengthRead = readProperty(source, "length");
  const length = lengthRead.ok && typeof lengthRead.value === "number" ? Math.min(lengthRead.value, 10_000) : 0;
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const entry = readProperty(source, index);
    result.push(entry.ok ? (convert(entry.value) ?? null) : UNSERIALIZABLE);
  }
  return result;
}

function describeNonError(value: unknown): unknown {
  return isPrimitive(value) ? value : `[non-error ${value === null ? "null" : typeof value}]`;
}

/**
 * Converts caller data into plain JSON-safe values *before* JSON.stringify, so serialization can
 * neither throw nor run code on errors: bigints become strings, cycles become "[Circular]", errors
 * go through the allowlist, throwing getters/toJSON become "[unserializable]", depth is bounded.
 * Non-error `toJSON` (Date, Decimal, …) is honoured, as JSON.stringify would.
 */
function toJsonSafe(value: unknown, ancestors: unknown[], depth: number): unknown {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : null;
    case "bigint":
      return value.toString();
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
    case "object":
      break;
  }
  if (value === null) {
    return null;
  }
  if (ancestors.includes(value)) {
    return "[Circular]";
  }
  if (depth >= MAX_DEPTH) {
    return "[Truncated]";
  }
  ancestors.push(value);
  try {
    if (isError(value)) {
      return serializeError(value, ancestors, depth);
    }
    // Same order as JSON.stringify: a non-error value's own toJSON (arrays included) wins.
    const toJSON = readProperty(value, "toJSON");
    if (!toJSON.ok) {
      return UNSERIALIZABLE;
    }
    if (typeof toJSON.value === "function") {
      try {
        return toJsonSafe((toJSON.value as () => unknown).call(value), ancestors, depth + 1);
      } catch {
        return UNSERIALIZABLE;
      }
    }
    if (Array.isArray(value)) {
      return copyArray(value, (entry) => toJsonSafe(entry, ancestors, depth + 1));
    }
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value)) {
      const read = readProperty(value, key);
      const converted = read.ok ? toJsonSafe(read.value, ancestors, depth + 1) : UNSERIALIZABLE;
      if (converted !== undefined) {
        result[key] = converted;
      }
    }
    return result;
  } catch {
    // e.g. a Proxy whose ownKeys trap throws.
    return UNSERIALIZABLE;
  } finally {
    ancestors.pop();
  }
}
