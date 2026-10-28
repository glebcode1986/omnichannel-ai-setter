/**
 * What this deployment offers, and where it will send somebody (#117).
 *
 * Two rules are worth more than the rest of this file. A method that is **half** configured must not be
 * offered, because the failure lands at the provider where a customer cannot read it. And a sign-in must
 * not redirect off this origin, because the product's own sign-in is then a credible way to deliver
 * somebody to a page that looks like it.
 */
import { describe, expect, it } from "vitest";

import { availableSignInMethods, DEFAULT_SIGNED_IN_PATH, safeRedirectTarget, type SignInConfig } from "./sign-in-methods";

const BASE = "https://app.example";

const config = (overrides: Partial<SignInConfig> = {}): SignInConfig => ({
  NODE_ENV: "production",
  AUTH_URL: BASE,
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
  AUTH_EMAIL_SERVER: "smtp://user:pass@mail.example:587",
  AUTH_EMAIL_FROM: "Omnichannel <no-reply@app.example>",
  ...overrides,
});

describe("the sign-in methods a deployment offers", () => {
  it("offers both when both are configured, against the configured origin", () => {
    expect(availableSignInMethods(config())).toEqual({ available: ["google", "email"], withheld: [], baseUrl: BASE });
  });

  it("withholds a half-configured method and distinguishes it from an unconfigured one", () => {
    // The distinction is the whole point: "not set up" is a decision, "half set up" is a mistake, and an
    // operator reading the second needs to know it is theirs to finish.
    expect(availableSignInMethods(config({ GOOGLE_CLIENT_SECRET: undefined })).withheld).toContainEqual({
      method: "google",
      reason: "PARTIALLY_CONFIGURED",
    });
    expect(availableSignInMethods(config({ GOOGLE_CLIENT_ID: undefined })).withheld).toContainEqual({
      method: "google",
      reason: "PARTIALLY_CONFIGURED",
    });
    expect(availableSignInMethods(config({ AUTH_EMAIL_FROM: undefined })).withheld).toContainEqual({
      method: "email",
      reason: "PARTIALLY_CONFIGURED",
    });
    expect(availableSignInMethods(config({ AUTH_EMAIL_SERVER: undefined })).withheld).toContainEqual({
      method: "email",
      reason: "PARTIALLY_CONFIGURED",
    });
  });

  it("reports both as unconfigured when nothing is set, and offers nothing", () => {
    const verdict = availableSignInMethods(
      config({ GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined, AUTH_EMAIL_SERVER: undefined, AUTH_EMAIL_FROM: undefined }),
    );

    expect(verdict.available).toEqual([]);
    expect(verdict.withheld).toEqual([
      { method: "google", reason: "NOT_CONFIGURED" },
      { method: "email", reason: "NOT_CONFIGURED" },
    ]);
  });

  it("offers nothing at all without a configured origin, however complete the rest is", () => {
    // The one that matters most. Without `AUTH_URL` the only other source of an absolute URL is the
    // request's own `Host` header — and a one-time link built from a header is the credential, mailed to
    // whoever set it.
    const verdict = availableSignInMethods(config({ AUTH_URL: undefined }));

    expect(verdict.available).toEqual([]);
    expect(verdict.withheld).toEqual([
      { method: "google", reason: "NO_BASE_URL" },
      { method: "email", reason: "NO_BASE_URL" },
    ]);
    expect(verdict.baseUrl).toBeUndefined();
  });

  it("refuses a plain-HTTP origin in production and allows it in development", () => {
    expect(availableSignInMethods(config({ AUTH_URL: "http://app.example" })).withheld).toEqual([
      { method: "google", reason: "INSECURE_BASE_URL" },
      { method: "email", reason: "INSECURE_BASE_URL" },
    ]);
    // Locally the flow has to be runnable at all.
    expect(availableSignInMethods(config({ AUTH_URL: "http://localhost:3000", NODE_ENV: "development" }))).toMatchObject({
      available: ["google", "email"],
      baseUrl: "http://localhost:3000",
    });
  });

  it("normalizes the origin, so a configured path cannot leak into a callback URL", () => {
    // A callback built by concatenation onto a path is a URL no provider has on its allowlist, and it
    // fails at the provider rather than here.
    expect(availableSignInMethods(config({ AUTH_URL: "https://app.example/app/" })).baseUrl).toBe(BASE);
  });

  it("treats a variable set to whitespace as not set", () => {
    expect(availableSignInMethods(config({ GOOGLE_CLIENT_SECRET: "   " })).withheld).toContainEqual({
      method: "google",
      reason: "PARTIALLY_CONFIGURED",
    });
    expect(availableSignInMethods(config({ AUTH_URL: "  " })).available).toEqual([]);
  });

  it("refuses an origin it cannot parse rather than assuming one", () => {
    expect(availableSignInMethods(config({ AUTH_URL: "not a url" })).withheld).toEqual([
      { method: "google", reason: "NO_BASE_URL" },
      { method: "email", reason: "NO_BASE_URL" },
    ]);
  });
});

describe("where a sign-in may send somebody", () => {
  it("keeps a path on this origin, with its query and fragment", () => {
    expect(safeRedirectTarget("/workspaces/ws_1/profiles/bp_1/setup?step=CHANNELS#top", BASE)).toBe(
      "/workspaces/ws_1/profiles/bp_1/setup?step=CHANNELS#top",
    );
  });

  it("reduces a same-origin absolute URL to its path", () => {
    // One answer out of both forms, and no redirect this product performs carries an editable origin.
    expect(safeRedirectTarget(`${BASE}/workspaces/ws_1`, BASE)).toBe("/workspaces/ws_1");
  });

  it("sends an unasked-for sign-in to the chooser", () => {
    expect(safeRedirectTarget(undefined, BASE)).toBe(DEFAULT_SIGNED_IN_PATH);
    expect(safeRedirectTarget("   ", BASE)).toBe(DEFAULT_SIGNED_IN_PATH);
  });

  it.each([
    ["another origin", "https://evil.example/pretend-sign-in"],
    ["a protocol-relative authority", "//evil.example/pretend-sign-in"],
    ["a javascript URL", "javascript:alert(1)"],
    ["a data URL", "data:text/html,<h1>hi</h1>"],
    ["a backslash-smuggled authority", "/\\evil.example"],
    ["a backslash pair", "\\\\evil.example"],
    ["an unparseable value", "http://[::1"],
    ["the same host on another scheme", "http://app.example/workspaces"],
    ["a lookalike host", "https://app.example.evil.test/workspaces"],
  ])("refuses %s and sends them to the chooser instead", (_case, requested) => {
    expect(safeRedirectTarget(requested, BASE)).toBe(DEFAULT_SIGNED_IN_PATH);
  });

  it("resolves a relative value onto this origin rather than refusing it", () => {
    expect(safeRedirectTarget("workspaces", BASE)).toBe("/workspaces");
    // Traversal is normalized by URL resolution, so it cannot climb out of the origin either.
    expect(safeRedirectTarget("/../../etc/passwd", BASE)).toBe("/etc/passwd");
  });

  it("falls back when the base it is given is itself unusable", () => {
    expect(safeRedirectTarget("/workspaces", "not a url")).toBe(DEFAULT_SIGNED_IN_PATH);
  });
});
