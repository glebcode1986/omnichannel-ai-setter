import { z } from "zod";

export type EnvSource = Readonly<Record<string, string | undefined>>;

export interface ParseEnvOptions {
  /**
   * Treat `KEY=` (empty string) as unset so defaults/required checks apply.
   * Defaults to `true`, because empty assignments in `.env` files are almost always accidental.
   */
  emptyStringAsUndefined?: boolean;
}

export interface EnvIssue {
  /**
   * Name of the schema-declared variable that failed validation, `(root)` for object-level issues or
   * `(schema)` when the schema threw. Nested path segments are never included (they can be input).
   */
  readonly key: string;
  /**
   * Zod's built-in message for the failed check (these never include the input), or a fixed
   * placeholder when the schema supplied a custom message, which could interpolate the value.
   */
  readonly message: string;
}

/**
 * Thrown when environment validation fails. Every part of the message comes from the schema or from
 * fixed text: schema-declared variable names, Zod's built-in descriptions for issue kinds whose
 * metadata is schema-owned (expected type/format/bounds/options), and placeholders for everything
 * else — custom messages, input-derived metadata such as unrecognized keys, and thrown exceptions.
 */
export class EnvValidationError extends Error {
  readonly issues: readonly EnvIssue[];

  constructor(issues: readonly EnvIssue[]) {
    super(
      [
        "Invalid environment configuration:",
        ...issues.map((issue) => `  - ${issue.key}: ${issue.message}`),
      ].join("\n"),
    );
    this.name = "EnvValidationError";
    this.issues = issues;
  }
}

const MESSAGE_WITHHELD = "Invalid value (validation details withheld; they may contain the value)";
const NESTED_SUFFIX = " (in a nested value)";
const SCHEMA_THREW = "Validation threw an exception (details withheld; they may contain values)";

/**
 * Issue kinds whose built-in message is assembled only from schema-owned metadata (expected type,
 * format/pattern, bounds, allowed options) or is generic. Everything else is withheld — notably
 * `custom` (arbitrary text) and `unrecognized_keys` (lists keys taken from the input). New Zod
 * issue kinds are withheld until reviewed and added here.
 */
const SCHEMA_OWNED_ISSUE_CODES: ReadonlySet<string> = new Set([
  "invalid_type",
  "invalid_value",
  "invalid_format",
  "too_small",
  "too_big",
  "not_multiple_of",
  "invalid_union",
  "invalid_key",
  "invalid_element",
]);

/**
 * Built-in Zod schema types and checks that raise issues from their own definition. Issues raised by
 * schema code — refine/superRefine/check callbacks, transforms, preprocess and codecs — come from
 * `custom`/`transform` instances or have no instance, so their metadata (and message) is untrusted.
 */
const BUILT_IN_SCHEMA_TYPES: ReadonlySet<string> = new Set([
  "string", "number", "bigint", "boolean", "date", "symbol", "null", "undefined", "void", "never", "nan",
  "enum", "literal", "object", "array", "tuple", "record", "map", "set", "union", "intersection",
  "template_literal", "file",
]);
const BUILT_IN_CHECKS: ReadonlySet<string> = new Set([
  "min_length", "max_length", "length_equals", "min_size", "max_size", "size_equals",
  "greater_than", "less_than", "multiple_of", "string_format", "number_format", "bigint_format", "mime_type",
]);

interface RawIssueSource {
  _zod?: { def?: { type?: unknown; check?: unknown } };
}

function isRaisedByBuiltInSchema(inst: RawIssueSource | undefined): boolean {
  const def = inst?._zod?.def;
  if (!def || def.type === "custom" || def.check === "custom" || def.type === "transform" || def.type === "pipe") {
    return false;
  }
  return (
    (typeof def.check === "string" && BUILT_IN_CHECKS.has(def.check)) ||
    (def.check === undefined && typeof def.type === "string" && BUILT_IN_SCHEMA_TYPES.has(def.type))
  );
}

/** A value of the same primitive type, so the locale message never sees the real input. */
function typeStandIn(value: unknown): unknown {
  switch (typeof value) {
    case "string":
      return "";
    case "number":
      return 0;
    case "bigint":
      return 0n;
    case "boolean":
      return false;
    case "undefined":
      return undefined;
    case "symbol":
    case "function":
    case "object":
      return value === null ? null : {};
  }
}

/** Unpredictable per call, so schema-authored messages cannot imitate a trusted one. */
function createTrustMarker(): string {
  return `\u0000trusted:${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}\u0000`;
}

/**
 * Validates `source` (default `process.env`) against a Zod object schema and returns the typed,
 * defaulted result. Unknown variables are ignored; only the keys declared in `schema` are read.
 *
 * Diagnostics are value-free by construction (see `EnvValidationError`): keys are schema-declared
 * variable names, messages are safe built-in descriptions or fixed placeholders, and exceptions
 * thrown inside the schema become a fixed `(schema)` issue.
 */
export function parseEnv<TShape extends z.ZodRawShape>(
  schema: z.ZodObject<TShape>,
  source: EnvSource = process.env,
  options: ParseEnvOptions = {},
): z.output<z.ZodObject<TShape>> {
  const emptyStringAsUndefined = options.emptyStringAsUndefined ?? true;

  const input: Record<string, string | undefined> = {};
  for (const key of Object.keys(schema.shape)) {
    const value = source[key];
    input[key] = emptyStringAsUndefined && value === "" ? undefined : value;
  }

  // Trust is decided while parsing, when Zod still exposes which schema raised each issue. Only
  // issues from built-in schemas/checks get a locale message (built from a type stand-in, without
  // the path) carrying the marker; issues with explicit or schema-defined messages never reach this
  // hook, and issues raised by schema code are left unmarked — both end up withheld.
  const marker = createTrustMarker();
  const trustedMessage = (issue: z.core.$ZodRawIssue): string | undefined => {
    const inst = (issue as { inst?: RawIssueSource }).inst;
    if (!SCHEMA_OWNED_ISSUE_CODES.has(issue.code ?? "") || !isRaisedByBuiltInSchema(inst)) {
      return undefined;
    }
    // Resolved lazily: Zod installs its default locale on first use.
    const localeError = z.config().localeError ?? z.locales.en().localeError;
    const localized = localeError?.({ ...issue, input: typeStandIn(issue.input), path: [] } as Parameters<
      NonNullable<typeof localeError>
    >[0]);
    const text = typeof localized === "string" ? localized : localized?.message;
    return text === undefined ? undefined : `${marker}${text}`;
  };

  let result: ReturnType<typeof schema.safeParse>;
  let issues: readonly z.core.$ZodIssue[];
  try {
    // `reportInput` stays off so issues never carry the raw (possibly secret) value. Issues are
    // finalized lazily, so read them inside the try: a throwing error map must not escape either.
    result = schema.safeParse(input, { error: trustedMessage });
    issues = result.success ? [] : result.error.issues;
  } catch {
    // e.g. a transform calling JSON.parse/new URL on a malformed secret: the error may quote it.
    throw new EnvValidationError([{ key: "(schema)", message: SCHEMA_THREW }]);
  }

  if (!result.success) {
    const declaredKeys = new Set(Object.keys(schema.shape));
    throw new EnvValidationError(
      issues.map((issue) => {
        const firstSegment = issue.path[0];
        const variable = typeof firstSegment === "string" && declaredKeys.has(firstSegment) ? firstSegment : undefined;
        const message = issue.message.startsWith(marker) ? issue.message.slice(marker.length) : MESSAGE_WITHHELD;
        return {
          key: variable ?? "(root)",
          message: issue.path.length > 1 ? `${message}${NESTED_SUFFIX}` : message,
        };
      }),
    );
  }
  return result.data;
}
