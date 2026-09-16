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
  /** Variable name (or nested path) that failed validation. */
  readonly key: string;
  /**
   * Zod's built-in message for the failed check (these never include the input), or a fixed
   * placeholder when the schema supplied a custom message, which could interpolate the value.
   */
  readonly message: string;
}

/**
 * Thrown when environment validation fails. The message lists variable names plus Zod's built-in
 * rule descriptions; custom schema messages and exceptions thrown by transforms are replaced with
 * fixed text, so no part of the message is derived from the environment values.
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

const CUSTOM_MESSAGE_WITHHELD = "Invalid value (custom validation message withheld; it may contain the value)";
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
 * True when `issue.message` is exactly what Zod's locale produces for this issue without seeing the
 * input — i.e. a built-in message, not one authored by the schema (which could embed the value).
 */
function isBuiltInMessage(issue: z.core.$ZodIssue, rawInput: unknown): boolean {
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
 * Error messages are value-free by construction: built-in Zod messages are kept, custom messages
 * are replaced with a fixed placeholder and exceptions thrown inside the schema become a fixed
 * `(schema)` issue.
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
    throw new EnvValidationError(
      result.error.issues.map((issue) => {
        const firstSegment = issue.path[0];
        const rawInput = typeof firstSegment === "string" ? input[firstSegment] : undefined;
        return {
          key: issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)",
          message: isBuiltInMessage(issue, rawInput) ? issue.message : CUSTOM_MESSAGE_WITHHELD,
        };
      }),
    );
  }
  return result.data;
}
