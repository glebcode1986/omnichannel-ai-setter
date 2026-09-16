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

  it("withholds custom messages that interpolate the rejected value", () => {
    const secret = "fake-app-secret-value";
    const schema = z.object({
      APP_SECRET: z.string().refine(() => false, { error: (issue) => `bad secret ${String(issue.input)}` }),
      OTHER: z.string().refine(() => false, { error: "must be something else" }),
    });

    const error = captureError(() => parseEnv(schema, { APP_SECRET: secret, OTHER: "abc" }));

    expect(error.issues).toEqual([
      { key: "APP_SECRET", message: expect.stringContaining("withheld") as string },
      { key: "OTHER", message: "must be something else" },
    ]);
    expect(error.message).not.toContain(secret);
  });

  it("converts exceptions thrown by transforms into a value-free EnvValidationError", () => {
    const secret = "not-json-app-secret-value";
    const schema = z.object({
      SECRETS_JSON: z.string().transform((value) => JSON.parse(value) as unknown),
      CALLBACK_URL: z.string().transform((value) => new URL(value)),
    });

    for (const source of [{ SECRETS_JSON: secret, CALLBACK_URL: "https://example.test" }, { SECRETS_JSON: "{}", CALLBACK_URL: secret }]) {
      const error = captureError(() => parseEnv(schema, source));

      expect(error.issues).toEqual([{ key: "(schema)", message: expect.stringMatching(/threw (SyntaxError|TypeError)/) as string }]);
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
