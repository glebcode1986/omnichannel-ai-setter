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
  /** Validation message. Never contains the offending value. */
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

/**
 * Validates `source` (default `process.env`) against a Zod object schema and returns the typed,
 * defaulted result. Unknown variables are ignored; only the keys declared in `schema` are read.
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

  // `reportInput` stays off so issues never carry the raw (possibly secret) value.
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => ({
        key: issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)",
        message: issue.message,
      })),
    );
  }
  return result.data;
}
