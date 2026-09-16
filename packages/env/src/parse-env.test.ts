import { describe, expect, it } from "vitest";
import { z } from "zod";

import { EnvValidationError, parseEnv } from "./parse-env";
import { runtimeEnvSchema } from "./schemas";

describe("parseEnv", () => {
  it("applies runtime defaults when variables are unset", () => {
    expect(parseEnv(runtimeEnvSchema, {})).toEqual({ NODE_ENV: "development", LOG_LEVEL: "info" });
  });

  it("returns typed values for valid input and ignores undeclared variables", () => {
    const env = parseEnv(runtimeEnvSchema, {
      NODE_ENV: "production",
      LOG_LEVEL: "warn",
      UNRELATED_SECRET: "ignored",
    });

    expect(env).toEqual({ NODE_ENV: "production", LOG_LEVEL: "warn" });
  });

  it("treats empty strings as unset by default", () => {
    expect(parseEnv(runtimeEnvSchema, { LOG_LEVEL: "" }).LOG_LEVEL).toBe("info");
  });

  it("can keep empty strings when explicitly requested", () => {
    const schema = z.object({ OPTIONAL_SUFFIX: z.string().optional() });

    expect(parseEnv(schema, { OPTIONAL_SUFFIX: "" }, { emptyStringAsUndefined: false })).toEqual({
      OPTIONAL_SUFFIX: "",
    });
  });

  it("reports every invalid variable in one error", () => {
    const schema = runtimeEnvSchema.extend({ REQUIRED_URL: z.url() });

    let caught: unknown;
    try {
      parseEnv(schema, { NODE_ENV: "staging" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(EnvValidationError);
    const keys = (caught as EnvValidationError).issues.map((issue) => issue.key);
    expect(keys).toEqual(expect.arrayContaining(["NODE_ENV", "REQUIRED_URL"]));
    expect((caught as EnvValidationError).message).toContain("Invalid environment configuration");
  });

  it("never includes rejected values in the error message or issues", () => {
    const secret = "fake-credential-value-must-not-leak";
    const schema = z.object({ API_TOKEN: z.string().regex(/^tok_/), LOG_LEVEL: z.enum(["info"]) });

    let caught: unknown;
    try {
      parseEnv(schema, { API_TOKEN: secret, LOG_LEVEL: secret });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(EnvValidationError);
    expect((caught as EnvValidationError).message).not.toContain(secret);
    expect(JSON.stringify((caught as EnvValidationError).issues)).not.toContain(secret);
  });

  it("keeps Zod's built-in messages, including allowed options for near-miss typos", () => {
    const error = captureError(() => parseEnv(runtimeEnvSchema, { NODE_ENV: "prod", LOG_LEVEL: "err" }));

    expect(error.issues).toEqual([
      { key: "NODE_ENV", message: 'Invalid option: expected one of "development"|"test"|"production"' },
      { key: "LOG_LEVEL", message: 'Invalid option: expected one of "debug"|"info"|"warn"|"error"' },
    ]);
  });

  it("replaces every custom message, whether it echoes, escapes, truncates or never mentions the value", () => {
    const schema = z.object({
      VERBATIM: z.string().refine(() => false, { error: (issue) => `bad ${String(issue.input)}` }),
      ESCAPED: z.string().refine(() => false, { error: (issue) => `got ${JSON.stringify(issue.input)}` }),
      TRUNCATED: z.string().refine(() => false, { error: (issue) => `${String(issue.input).slice(0, 8)}...` }),
      TRIMMED: z
        .string()
        .trim()
        .min(100, { error: (issue) => `too short: ${issue.input as string}` }),
      STATIC: z.string().refine(() => false, "must be something else"),
    });
    const values = {
      VERBATIM: "verbatim-secret",
      ESCAPED: 'esc"aped\\secret',
      TRUNCATED: "tok_live_ABCDEFGHIJ",
      TRIMMED: "  padded-secret  ",
      STATIC: "static-secret",
    };

    const error = captureError(() => parseEnv(schema, values));

    expect(error.issues).toEqual([
      { key: "VERBATIM", message: "Invalid value (custom validation details withheld)" },
      { key: "ESCAPED", message: "Invalid value (custom validation details withheld)" },
      { key: "TRUNCATED", message: "Invalid value (custom validation details withheld)" },
      { key: "TRIMMED", message: "Too small: expected string with length >= 100" },
      { key: "STATIC", message: "Invalid value (custom validation details withheld)" },
    ]);
    for (const fragment of ["verbatim-secret", "aped", "tok_live", "padded-secret", "static-secret"]) {
      expect(error.message).not.toContain(fragment);
    }
  });

  it("withholds built-in messages whose metadata comes from the input, such as unrecognized keys (R1-03)", () => {
    const secret = "r1-fake-secret-DO-NOT-LOG";
    const schema = z.object({
      CONFIG: z
        .string()
        .transform((value) => JSON.parse(value) as unknown)
        .pipe(z.strictObject({})),
    });

    const error = captureError(() => parseEnv(schema, { CONFIG: JSON.stringify({ [secret]: true }) }));

    expect(error.issues).toEqual([{ key: "CONFIG", message: expect.stringMatching(/withheld/) as string }]);
    expect(JSON.stringify(error.issues)).not.toContain(secret);
    expect(error.message).not.toContain(secret);
  });

  it("never copies issue paths beyond the schema-declared variable name (R1-03)", () => {
    const secret = "r1-fake-secret-DO-NOT-LOG";
    const schema = z
      .object({
        TOKEN: z.string().superRefine((value, ctx) => {
          ctx.addIssue({ code: "custom", path: [value], message: "invalid" });
        }),
        RECORD_JSON: z
          .string()
          .transform((value) => JSON.parse(value) as unknown)
          .pipe(z.record(z.string(), z.number())),
      })
      .superRefine((value, ctx) => {
        ctx.addIssue({ code: "custom", path: [value.TOKEN], message: "object-level" });
      });

    const error = captureError(() =>
      parseEnv(schema, { TOKEN: secret, RECORD_JSON: JSON.stringify({ [secret]: "not-a-number" }) }),
    );

    expect(error.issues.map((issue) => issue.key).sort()).toEqual(["RECORD_JSON", "TOKEN"]);
    expect(error.issues.find((issue) => issue.key === "RECORD_JSON")?.message).toBe(
      "Invalid input: expected number (in a nested value)",
    );
    expect(JSON.stringify(error.issues)).not.toContain(secret);
    expect(error.message).not.toContain(secret);
  });

  it("does not trust allowlisted issue kinds that schema code raises with the value in their metadata (R1-03 follow-up)", () => {
    const secret = "SYNTH-SECRET-r103-follow-up";
    const schema = z.object({
      SUPER_VALUE: z.string().superRefine((value, ctx) => {
        ctx.addIssue({ code: "invalid_value", values: [value] });
      }),
      SUPER_TYPE: z.string().superRefine((value, ctx) => {
        ctx.addIssue({ code: "invalid_type", expected: value as never });
      }),
      SUPER_FORMAT: z.string().superRefine((value, ctx) => {
        ctx.addIssue({ code: "invalid_format", format: value as never });
      }),
      CHECK: z.string().check((ctx) => {
        ctx.issues.push({ code: "too_big", origin: ctx.value as never, maximum: 1, input: ctx.value, inclusive: true });
      }),
      TRANSFORM: z.string().transform((value, ctx) => {
        ctx.addIssue({ code: "invalid_value", values: [value] });
        return value;
      }),
      PREPROCESS: z.preprocess((value, ctx) => {
        ctx.addIssue({ code: "not_multiple_of", divisor: value as number, input: value as number });
        return value;
      }, z.string()),
      CODEC: z.codec(z.string(), z.number(), {
        decode: (value, ctx) => {
          ctx.issues.push({ code: "invalid_type", expected: value as never, input: value });
          return 0;
        },
        encode: (value) => String(value),
      }),
    });
    const values = Object.fromEntries(Object.keys(schema.shape).map((key) => [key, secret]));

    const error = captureError(() => parseEnv(schema, values));

    expect(error.issues.length).toBeGreaterThanOrEqual(7);
    expect(JSON.stringify(error.issues)).not.toContain(secret);
    expect(error.message).not.toContain(secret);
  });

  it("ignores global locales and error maps that echo input, paths or nested messages (R1-03 follow-up)", () => {
    const secret = "SYNTH-SECRET-error-maps";
    const previousLocale = z.config().localeError;
    z.config({
      localeError: (issue) =>
        `${issue.path?.join(".") ?? ""} ${JSON.stringify((issue as { errors?: unknown }).errors ?? "")} ${String(issue.input)}`,
    });
    try {
      const schema = z.object({
        REDIS_URL: z.union(
          [
            z.url({ protocol: /^rediss?$/ }),
            z.string().refine((value) => value.startsWith("/"), {
              error: (issue) => `not an absolute socket path: ${String(issue.input)}`,
            }),
          ],
          {
            error: (issue) =>
              issue.code === "invalid_union"
                ? issue.errors.map((branch) => branch.map((inner) => inner.message).join(", ")).join(" or ")
                : undefined,
          },
        ),
        RECORD_JSON: z
          .string()
          .transform((value) => JSON.parse(value) as unknown)
          .pipe(z.record(z.string(), z.number())),
        FORGED: z.string().superRefine((value, ctx) => {
          ctx.addIssue({ code: "invalid_format", format: "starts_with", prefix: value, input: value, inst: z.string().regex(/^x/) });
        }),
        NON_STRING: z
          .string()
          .refine(() => false, { error: (issue) => ({ message: { leak: issue.input } as unknown as string }) }),
      });

      const error = captureError(() =>
        parseEnv(schema, {
          REDIS_URL: secret,
          RECORD_JSON: JSON.stringify({ [secret]: "x" }),
          FORGED: secret,
          NON_STRING: secret,
        }),
      );

      expect(error.issues).toEqual([
        { key: "REDIS_URL", message: "Matched no allowed alternative" },
        { key: "RECORD_JSON", message: "Invalid input: expected number (in a nested value)" },
        { key: "FORGED", message: "Invalid format: expected string" },
        { key: "NON_STRING", message: "Invalid value (custom validation details withheld)" },
      ]);
      expect(error.message).not.toContain(secret);
    } finally {
      z.config({ localeError: previousLocale });
    }
  });

  it("describes common env schemas truthfully without the value (coerced numbers, required optionals, stringbool)", () => {
    const schema = z.object({
      WORKER_CONCURRENCY: z.coerce.number().int().min(1),
      PORT: z.string().transform(Number).pipe(z.number().int().max(65_535)),
      REDIS_URL: z.url().optional().nonoptional(),
      AI_REPLIES_ENABLED: z.stringbool(),
    });

    const error = captureError(() =>
      parseEnv(schema, { WORKER_CONCURRENCY: "four", PORT: "not-a-port", AI_REPLIES_ENABLED: "sometimes" }),
    );

    expect(error.issues).toEqual([
      { key: "WORKER_CONCURRENCY", message: "Invalid input: expected integer >= 1, received string" },
      { key: "PORT", message: "Invalid input: expected integer <= 65535, received string" },
      { key: "REDIS_URL", message: "Invalid input: expected a valid url, received undefined" },
      { key: "AI_REPLIES_ENABLED", message: expect.stringMatching(/^Invalid option/) as string },
    ]);
    expect(error.message).not.toMatch(/four|not-a-port|sometimes/);
  });

  it("names the rule that actually failed for formats combined with length, prefix and numeric checks", () => {
    const schema = z.object({
      ENCRYPTION_KEY_HEX: z.hex().length(64),
      AUTH_URL: z.url().startsWith("https://"),
      WEBHOOK_BASE_URL: z.url().endsWith("/"),
      DATABASE_URL: z.string().url(),
      SHORT_URL: z.url().max(20),
      FIXED_KEY: z.string().length(64),
      BATCH: z.coerce.number().multipleOf(5),
      RETRY_AFTER: z.coerce.date().min(new Date("2026-01-01T00:00:00.000Z")),
      LIMIT: z.coerce.bigint().min(10n),
      TAGS: z
        .string()
        .transform((value) => value.split(","))
        .pipe(z.array(z.string()).min(3)),
      WORKERS: z.string().transform(Number).pipe(z.int().min(1)),
    });

    const error = captureError(() =>
      parseEnv(schema, {
        ENCRYPTION_KEY_HEX: "ab".repeat(16),
        AUTH_URL: "http://app.example.com",
        WEBHOOK_BASE_URL: "https://hooks.example.com",
        DATABASE_URL: "localhost",
        SHORT_URL: "https://a-rather-long-host.example.com/path",
        FIXED_KEY: "short",
        BATCH: "7",
        RETRY_AFTER: "2025-06-01",
        LIMIT: "3",
        TAGS: "a,b",
        WORKERS: "1.5",
      }),
    );

    expect(error.issues).toEqual([
      { key: "ENCRYPTION_KEY_HEX", message: "Too small: expected a valid hex with length = 64" },
      { key: "AUTH_URL", message: 'Invalid format: expected a valid url, starting with "https://"' },
      { key: "WEBHOOK_BASE_URL", message: 'Invalid format: expected a valid url, ending with "/"' },
      { key: "DATABASE_URL", message: "Invalid format: expected a valid url" },
      { key: "SHORT_URL", message: "Too big: expected a valid url with length <= 20" },
      { key: "FIXED_KEY", message: "Too small: expected string with length = 64" },
      { key: "BATCH", message: "Invalid multiple: expected a multiple of 5" },
      { key: "RETRY_AFTER", message: "Too small: expected date >= 2026-01-01T00:00:00.000Z" },
      { key: "LIMIT", message: "Too small: expected bigint >= 10" },
      { key: "TAGS", message: "Too small: expected array with length >= 3" },
      { key: "WORKERS", message: "Invalid input: expected integer >= 1, received string" },
    ]);
  });

  it("converts exceptions thrown by transforms into a fixed, value-free EnvValidationError", () => {
    const secret = "not-json-app-secret-value";
    class SecretBearingError extends Error {
      override name = `Bad(${secret})`;
    }
    const schema = z.object({
      SECRETS_JSON: z.string().transform((value) => JSON.parse(value) as unknown),
      CALLBACK_URL: z.string().transform((value) => new URL(value)),
      CUSTOM: z.string().transform(() => {
        throw new SecretBearingError(secret);
      }),
    });

    for (const source of [
      { SECRETS_JSON: secret, CALLBACK_URL: "https://example.test", CUSTOM: "x" },
      { SECRETS_JSON: "{}", CALLBACK_URL: secret, CUSTOM: "x" },
      { SECRETS_JSON: "{}", CALLBACK_URL: "https://example.test", CUSTOM: secret },
    ]) {
      const error = captureError(() => parseEnv(schema, source));

      expect(error.issues).toEqual([{ key: "(schema)", message: expect.stringMatching(/threw an exception/) as string }]);
      expect(error.message).not.toContain(secret);
      expect(error.cause).toBeUndefined();
    }
  });
});

function captureError(action: () => unknown): EnvValidationError {
  try {
    action();
  } catch (error) {
    if (error instanceof EnvValidationError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected parseEnv to throw");
}
