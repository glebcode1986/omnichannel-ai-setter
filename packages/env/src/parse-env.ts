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
const SCHEMA_THREW = "Validation threw an exception (details withheld; they may contain values)";

/** A value of the same primitive type, so regenerated messages never see the real input. */
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

/**
 * True when the issue kind carries only schema-owned metadata and `issue.message` is exactly what
 * Zod's locale produces for it without seeing the input — i.e. a built-in message, not one authored
 * by the schema (which could embed the value).
 */
function isSafeBuiltInMessage(issue: z.core.$ZodIssue, rawInput: unknown): boolean {
  if (!SCHEMA_OWNED_ISSUE_CODES.has(issue.code)) {
    return false;
  }
  // Resolved after parsing: Zod installs its default locale lazily.
  const localeError = z.config().localeError ?? z.locales.en().localeError;
  const regenerated = localeError?.({ ...issue, input: typeStandIn(rawInput) } as unknown as Parameters<
    NonNullable<typeof localeError>
  >[0]);
  const text = typeof regenerated === "string" ? regenerated : regenerated?.message;
  return text !== undefined && text === issue.message;
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

  let result: ReturnType<typeof schema.safeParse>;
  try {
    // `reportInput` stays off so issues never carry the raw (possibly secret) value.
    result = schema.safeParse(input);
  } catch {
    // e.g. a transform calling JSON.parse/new URL on a malformed secret: the error may quote it.
    throw new EnvValidationError([{ key: "(schema)", message: SCHEMA_THREW }]);
  }

  if (!result.success) {
    const declaredKeys = new Set(Object.keys(schema.shape));
    throw new EnvValidationError(
      result.error.issues.map((issue) => {
        const firstSegment = issue.path[0];
        const variable = typeof firstSegment === "string" && declaredKeys.has(firstSegment) ? firstSegment : undefined;
        const message = isSafeBuiltInMessage(issue, variable === undefined ? undefined : input[variable])
          ? issue.message
          : MESSAGE_WITHHELD;
        return {
          key: variable ?? "(root)",
          message: issue.path.length > 1 ? `${message}${NESTED_SUFFIX}` : message,
        };
      }),
    );
  }
  return result.data;
}
