import { EnvValidationError } from "@omnichannel/env";
import { describe, expect, it } from "vitest";

import { loadWebEnv } from "./env";

const required = {
  DATABASE_URL: "postgresql://user:fake-password@localhost:5432/omnichannel",
  AUTH_SECRET: "fake-auth-secret-for-tests-0123456789",
  REDIS_URL: "redis://127.0.0.1:6379",
  CHANNEL_CREDENTIAL_KEY_ID: "test-key-1",
  CHANNEL_CREDENTIAL_KEY: Buffer.alloc(32, 3).toString("base64"),
  INSTAGRAM_APP_ID: "1234567890",
  INSTAGRAM_APP_SECRET: "fake-instagram-app-secret",
  INSTAGRAM_REDIRECT_URI: "https://app.example.test/api/channels/instagram/callback",
};

describe("loadWebEnv", () => {
  it("applies defaults", () => {
    expect(loadWebEnv(required)).toEqual({
      NODE_ENV: "development",
      LOG_LEVEL: "info",
      // No API reports Human Agent approval, so it starts closed and an operator opts in.
      INSTAGRAM_HUMAN_AGENT_APPROVAL: "UNKNOWN",
      // Embeddings for the Knowledge Library's retrieval tester. No key means the tester runs lexical-only
      // and says so, which is what the worker does with the same setting — the model and width still have
      // defaults, so the two processes cannot drift apart by one of them omitting a value.
      AI_EMBEDDING_MODEL: "voyage-3.5",
      AI_EMBEDDING_DIMENSIONS: 1_024,
      AI_EMBEDDING_REVISION: "v1",
      ...required,
    });
  });

  it("takes no embedding key, because lexical-only retrieval is a supported mode", () => {
    // Requiring one would make an embeddings outage a boot failure for a surface that only reads.
    expect(loadWebEnv(required).VOYAGE_API_KEY).toBeUndefined();
  });

  it("reads the embedding settings the retrieval tester needs to match the worker", () => {
    const env = loadWebEnv({ ...required, VOYAGE_API_KEY: "fake-key", AI_EMBEDDING_DIMENSIONS: "1024" });

    expect(env.VOYAGE_API_KEY).toBe("fake-key");
    expect(env.AI_EMBEDDING_DIMENSIONS).toBe(1_024);
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
      // The credential key must be exactly 32 bytes of base64, or AES-256-GCM cannot be keyed.
      ["CHANNEL_CREDENTIAL_KEY", { ...required, CHANNEL_CREDENTIAL_KEY: Buffer.alloc(16, 3).toString("base64") }],
      ["CHANNEL_CREDENTIAL_KEY", { ...required, CHANNEL_CREDENTIAL_KEY: "fake-password-not-base64!!" }],
      ["CHANNEL_CREDENTIAL_KEY_ID", { ...required, CHANNEL_CREDENTIAL_KEY_ID: "" }],
      ["INSTAGRAM_APP_ID", { ...required, INSTAGRAM_APP_ID: "" }],
      ["INSTAGRAM_APP_SECRET", { ...required, INSTAGRAM_APP_SECRET: "" }],
      // Meta requires HTTPS, and an http redirect would expose the code in transit.
      ["INSTAGRAM_REDIRECT_URI", { ...required, INSTAGRAM_REDIRECT_URI: "http://app.example.test/callback" }],
      ["INSTAGRAM_REDIRECT_URI", { ...required, INSTAGRAM_REDIRECT_URI: "not-a-url" }],
      ["INSTAGRAM_HUMAN_AGENT_APPROVAL", { ...required, INSTAGRAM_HUMAN_AGENT_APPROVAL: "MAYBE" }],
      // Optional, but a guessable token is worse than none: absent binds no adapter, present and weak
      // would answer Meta's handshake for anyone who tried the obvious string.
      ["INSTAGRAM_VERIFY_TOKEN", { ...required, INSTAGRAM_VERIFY_TOKEN: "too-short" }],
    ] as const) {
      let error: unknown;
      try {
        loadWebEnv(source);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as EnvValidationError).issues.map((issue) => issue.key)).toContain(key);
      expect((error as EnvValidationError).message).not.toMatch(/fake-password|short-secret|fake-instagram-app-secret/);
    }
  });

  it("accepts a verify token without reporting it anywhere", () => {
    const verifyToken = "fake-instagram-verify-token";

    const env = loadWebEnv({ ...required, INSTAGRAM_VERIFY_TOKEN: verifyToken });

    expect(env.INSTAGRAM_VERIFY_TOKEN).toBe(verifyToken);
    // And an invalid *other* value must not drag it into the error, which is how secrets usually escape.
    let error: unknown;
    try {
      loadWebEnv({ ...required, INSTAGRAM_VERIFY_TOKEN: verifyToken, LOG_LEVEL: "loud" });
    } catch (caught) {
      error = caught;
    }
    expect((error as EnvValidationError).message).not.toContain(verifyToken);
  });
});
