import { EnvValidationError } from "@omnichannel/env";
import { describe, expect, it } from "vitest";

import { loadWebEnv } from "./env";

const required = {
  DATABASE_URL: "postgresql://user:fake-password@localhost:5432/omnichannel",
  AUTH_SECRET: "fake-auth-secret-for-tests-0123456789",
  REDIS_URL: "redis://127.0.0.1:6379",
};

describe("loadWebEnv", () => {
  it("applies defaults", () => {
    expect(loadWebEnv(required)).toEqual({ NODE_ENV: "development", LOG_LEVEL: "info", ...required });
  });

  it("rejects invalid values", () => {
    expect(() => loadWebEnv({ ...required, LOG_LEVEL: "loud" })).toThrow(EnvValidationError);
  });

  it("requires a PostgreSQL URL and a strong Auth.js secret without echoing them", () => {
    for (const [key, source] of [
      ["DATABASE_URL", { AUTH_SECRET: required.AUTH_SECRET }],
      ["DATABASE_URL", { ...required, DATABASE_URL: "mysql://user:fake-password@localhost/db" }],
      ["AUTH_SECRET", { DATABASE_URL: required.DATABASE_URL }],
      ["AUTH_SECRET", { ...required, AUTH_SECRET: "short-secret" }],
      ["REDIS_URL", { ...required, REDIS_URL: "http://user:fake-password@localhost:6379" }],
    ] as const) {
      let error: unknown;
      try {
        loadWebEnv(source);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as EnvValidationError).issues.map((issue) => issue.key)).toContain(key);
      expect((error as EnvValidationError).message).not.toMatch(/fake-password|short-secret/);
    }
  });
});
