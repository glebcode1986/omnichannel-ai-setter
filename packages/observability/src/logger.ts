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
  const context: SerializationContext = { ancestors: [], budget: MAX_NODES };
  // Null prototype: a `__proto__` field becomes a plain property instead of changing the prototype.
  const entry = Object.create(null) as Record<string, unknown>;
  for (const source of [bindings, fields ?? {}]) {
    for (const key of Object.keys(source)) {
      // An own `toJSON` would replace the whole entry during JSON.stringify. Each field is converted
      // on its own: the entry itself is never classified (a `message` + `stack` pair is just fields).
      if (!CORE_FIELDS.has(key) && key !== "toJSON") {
        const read = readProperty(source, key);
        const converted = read.ok ? toJsonSafe(read.value, context, 1) : UNSERIALIZABLE;
        if (converted !== undefined) {
          entry[key] = converted;
        }
      }
    }
  }
  entry.time = time.toISOString();
  entry.level = level;
  entry.event = event;
  return entry;
}

interface SerializationContext {
  readonly ancestors: unknown[];
  /** Objects/arrays still allowed in this entry; shared references cannot blow up memory. */
  budget: number;
}

const MAX_NODES = 50_000;
const MAX_ARRAY_ITEMS = 10_000;
const MAX_PROTOTYPE_HOPS = 1_000;
const nativeIsError = (Error as { isError?: (value: unknown) => boolean }).isError;

type Classification = "error" | "plain" | "untrusted";

/**
 * Brand checks first; otherwise walk the whole prototype chain looking for an `Error` constructor,
 * which also covers errors from other realms (vm contexts), custom `Symbol.toStringTag` and proxies
 * (whose receiver-checked `stack` reads as undefined). A chain that cannot be walked to its end is
 * "untrusted": it is neither serialized as an error nor allowed to run its toJSON.
 */
function classify(value: object): Classification {
  try {
    if (value instanceof Error || nativeIsError?.(value) === true || Object.prototype.toString.call(value) === "[object Error]") {
      return "error";
    }
  } catch {
    // A revoked proxy or hostile trap: continue with the prototype walk.
  }
  try {
    const seen = new Set<unknown>();
    let prototype: unknown = Object.getPrototypeOf(value);
    for (let hops = 0; hops < MAX_PROTOTYPE_HOPS; hops += 1) {
      if (prototype === null) {
        return "plain";
      }
      if (typeof prototype !== "object" || seen.has(prototype)) {
        return "untrusted";
      }
      seen.add(prototype);
      const constructor = readProperty(prototype, "constructor");
      if (constructor.ok && typeof constructor.value === "function" && constructor.value.name === "Error") {
        return "error";
      }
      prototype = Object.getPrototypeOf(prototype);
    }
  } catch {
    // Hostile getPrototypeOf trap.
  }
  return "untrusted";
}

function isError(value: unknown): value is Error {
  return typeof value === "object" && value !== null && classify(value) === "error";
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function describeNonError(value: unknown): unknown {
  return isPrimitive(value) ? value : `[non-error ${value === null ? "null" : typeof value}]`;
}

/**
 * Only name/message/stack, primitive diagnostic codes, and error-valued `cause`/`errors`
 * (AggregateError) and `error`/`suppressed` (SuppressedError) are kept. Nothing on the error is
 * invoked: its own `toJSON` (where HTTP clients expose request config) is never called, and throwing
 * getters yield a fixed placeholder.
 */
function serializeError(error: Error, context: SerializationContext, depth: number): Record<string, unknown> {
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
  for (const field of ["cause", "error", "suppressed"]) {
    const read = readProperty(error, field);
    if (!read.ok) {
      serialized[field] = UNSERIALIZABLE;
    } else if (read.value !== undefined) {
      serialized[field] = isError(read.value) ? toJsonSafe(read.value, context, depth + 1) : describeNonError(read.value);
    }
  }
  const errors = readProperty(error, "errors");
  if (!errors.ok) {
    serialized.errors = UNSERIALIZABLE;
  } else if (Array.isArray(errors.value)) {
    serialized.errors = copyArray(errors.value, (entry) =>
      isError(entry) ? toJsonSafe(entry, context, depth + 1) : describeNonError(entry),
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
  const length =
    lengthRead.ok && typeof lengthRead.value === "number" && Number.isFinite(lengthRead.value)
      ? Math.max(0, Math.min(Math.floor(lengthRead.value), MAX_ARRAY_ITEMS))
      : 0;
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const entry = readProperty(source, index);
    result.push(entry.ok ? (convert(entry.value) ?? null) : UNSERIALIZABLE);
  }
  if (lengthRead.ok && typeof lengthRead.value === "number" && lengthRead.value > MAX_ARRAY_ITEMS) {
    result.push("[Truncated]");
  }
  return result;
}

/**
 * Converts caller data into plain JSON-safe values *before* JSON.stringify, so serialization can
 * neither throw nor run code on errors: bigints become strings, cycles become "[Circular]", errors
 * go through the allowlist, throwing getters/toJSON become "[unserializable]", and depth, array size
 * and the total number of objects per entry are bounded. Non-error `toJSON` (Date, redacting
 * wrappers, …) is honoured, as JSON.stringify would.
 */
function toJsonSafe(value: unknown, context: SerializationContext, depth: number): unknown {
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
  if (context.ancestors.includes(value)) {
    return "[Circular]";
  }
  if (depth >= MAX_DEPTH || context.budget <= 0) {
    return "[Truncated]";
  }
  context.budget -= 1;
  context.ancestors.push(value);
  try {
    const classification = classify(value);
    if (classification === "error") {
      return serializeError(value as Error, context, depth);
    }
    if (classification === "untrusted") {
      return UNSERIALIZABLE;
    }
    // Same order as JSON.stringify: a non-error value's own toJSON (arrays included) wins.
    const toJSON = readProperty(value, "toJSON");
    if (!toJSON.ok) {
      return UNSERIALIZABLE;
    }
    if (typeof toJSON.value === "function") {
      try {
        return toJsonSafe((toJSON.value as () => unknown).call(value), context, depth + 1);
      } catch {
        return UNSERIALIZABLE;
      }
    }
    if (Array.isArray(value)) {
      return copyArray(value, (entry) => toJsonSafe(entry, context, depth + 1));
    }
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value)) {
      const read = readProperty(value, key);
      const converted = read.ok ? toJsonSafe(read.value, context, depth + 1) : UNSERIALIZABLE;
      if (converted !== undefined) {
        result[key] = converted;
      }
    }
    return result;
  } catch {
    // e.g. a Proxy whose ownKeys trap throws.
    return UNSERIALIZABLE;
  } finally {
    context.ancestors.pop();
  }
}
