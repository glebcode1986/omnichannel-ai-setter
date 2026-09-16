import type { z } from "zod";

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
  /** Validation message. Messages that would reveal the offending value are replaced. */
  readonly message: string;
}

/**
 * Thrown when environment validation fails. The message lists variable names and rule
 * violations only, never values, so it is safe to log even when a secret is malformed.
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

/** Values shorter than this are not searched for in messages (too likely to match by accident). */
const MIN_REDACTABLE_VALUE_LENGTH = 3;

const WITHHELD_MESSAGE = "Invalid value (validation message withheld because it contained the value)";

/**
 * Validates `source` (default `process.env`) against a Zod object schema and returns the typed,
 * defaulted result. Unknown variables are ignored; only the keys declared in `schema` are read.
 *
 * Built-in Zod checks never echo input. Custom error messages and throwing transforms can, so any
 * issue message containing the variable's value is withheld and exceptions thrown by the schema are
 * converted into a value-free `EnvValidationError`.
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
  } catch (error) {
    // e.g. a transform calling JSON.parse/new URL on a malformed secret: the thrown message may quote it.
    const errorName = error instanceof Error ? error.name : typeof error;
    throw new EnvValidationError([
      { key: "(schema)", message: `Validation threw ${errorName}; details withheld because they may contain values.` },
    ]);
  }

  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => {
        const firstSegment = issue.path[0];
        const relevantValues =
          typeof firstSegment === "string" && firstSegment in input
            ? [input[firstSegment]]
            : Object.values(input);
        const revealsValue = relevantValues.some(
          (value) => value !== undefined && value.length >= MIN_REDACTABLE_VALUE_LENGTH && issue.message.includes(value),
        );
        return {
          key: issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)",
          message: revealsValue ? WITHHELD_MESSAGE : issue.message,
        };
      }),
    );
  }
  return result.data;
}
