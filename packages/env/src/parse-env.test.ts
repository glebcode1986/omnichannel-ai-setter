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
});
