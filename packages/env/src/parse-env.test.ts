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

    expect(error.issues.map((issue) => issue.key)).toEqual(["VERBATIM", "ESCAPED", "TRUNCATED", "TRIMMED", "STATIC"]);
    for (const issue of error.issues) {
      expect(issue.message).toMatch(/withheld/);
    }
    for (const fragment of ["verbatim-secret", "aped", "tok_live", "padded-secret", "static-secret"]) {
      expect(error.message).not.toContain(fragment);
    }
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
