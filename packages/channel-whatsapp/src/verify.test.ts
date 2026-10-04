/**
 * Webhook authenticity (#18).
 *
 * The case that matters is the tampered body: the JSON parses identically and the digest does not, which is
 * the whole reason verification runs on raw bytes rather than on a re-serialized object. Everything else
 * here is a way of arriving at "not verified" — and each one has to arrive there, because a single
 * unverified payload reaching normalization is a stranger writing into a customer's conversation.
 */
import { describe, expect, it } from "vitest";

import { resolveConfig } from "./config";
import { assertVerified, verifyWhatsAppWebhook } from "./verify";
import { APP_SECRET, config, handshake, inboundText, signedWebhook, unsignedWebhook, VERIFY_TOKEN } from "./__fixtures__/payloads";

const resolved = (overrides: Parameters<typeof config>[0] = {}) => resolveConfig(config(overrides));

describe("a signed payload", () => {
  it("is verified when the digest matches the raw bytes", () => {
    expect(verifyWhatsAppWebhook(signedWebhook(inboundText()), resolved())).toEqual({ status: "VERIFIED" });
  });

  it("is rejected when a byte is added after signing", () => {
    // The payload still parses to the same object. Only the bytes differ, which is exactly what a
    // re-serializing verifier would miss.
    const result = verifyWhatsAppWebhook(signedWebhook(inboundText(), { tamper: true }), resolved());

    expect(result).toEqual({ status: "REJECTED", reason: "payload signature mismatch" });
  });

  it("is rejected when it was signed with another secret", () => {
    const result = verifyWhatsAppWebhook(signedWebhook(inboundText(), { secret: "someone-elses-secret" }), resolved());

    expect(result).toEqual({ status: "REJECTED", reason: "payload signature mismatch" });
  });

  it("is rejected when the signature is missing, truncated or not hex", () => {
    expect(verifyWhatsAppWebhook(unsignedWebhook(inboundText()), resolved())).toEqual({
      status: "REJECTED",
      reason: "missing payload signature",
    });
    const signed = signedWebhook(inboundText());
    const header = signed.headers["x-hub-signature-256"] ?? "";
    for (const [value, reason] of [
      [header.slice(0, -2), "payload signature mismatch"],
      ["sha256=not-hex-at-all", "malformed payload signature"],
      ["sha256=abc", "malformed payload signature"],
      [`sha1=${header.slice("sha256=".length)}`, "unsupported payload signature algorithm"],
    ] as const) {
      expect(verifyWhatsAppWebhook({ ...signed, headers: { "x-hub-signature-256": value } }, resolved())).toEqual({
        status: "REJECTED",
        reason,
      });
    }
  });

  it("is rejected when the adapter has no app secret, rather than accepted unchecked", () => {
    // Fail closed on configuration. The alternative — treating a missing secret as "nothing to check" —
    // accepts every stranger's payload and leaves no trace that it happened.
    const noSecret = resolved({
      secrets: { appSecret: "", verifyToken: VERIFY_TOKEN, accessToken: () => Promise.resolve("t") },
    });

    expect(verifyWhatsAppWebhook(signedWebhook(inboundText(), { secret: "" }), noSecret)).toEqual({
      status: "REJECTED",
      reason: "adapter has no app secret configured",
    });
  });
});

describe("the subscription handshake", () => {
  it("echoes the challenge byte for byte when the token matches", () => {
    const result = verifyWhatsAppWebhook(
      handshake({ "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "1158201444" }),
      resolved(),
    );

    expect(result).toEqual({ status: "CHALLENGE", responseBody: "1158201444" });
  });

  it("refuses a wrong token, a wrong mode and a missing challenge", () => {
    for (const [query, reason] of [
      [{ "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "1" }, "invalid verify token"],
      [{ "hub.mode": "unsubscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "1" }, "unsupported webhook handshake"],
      [{ "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN }, "missing challenge"],
    ] as const) {
      expect(verifyWhatsAppWebhook(handshake(query), resolved())).toEqual({ status: "REJECTED", reason });
    }
  });

  it("refuses an empty configured token, so a blank config cannot be guessed", () => {
    const blank = resolved({ secrets: { appSecret: APP_SECRET, verifyToken: "", accessToken: () => Promise.resolve("t") } });

    expect(verifyWhatsAppWebhook(handshake({ "hub.mode": "subscribe", "hub.verify_token": "", "hub.challenge": "1" }), blank)).toEqual({
      status: "REJECTED",
      reason: "invalid verify token",
    });
  });
});

describe("the guard before normalization", () => {
  it("throws for anything that is not VERIFIED, including a challenge", () => {
    expect(() => assertVerified({ status: "VERIFIED" })).not.toThrow();
    expect(() => assertVerified({ status: "REJECTED", reason: "x" })).toThrow(/unverified/u);
    // A challenge is a handshake answer, not a payload: normalizing one would be normalizing a GET.
    expect(() => assertVerified({ status: "CHALLENGE", responseBody: "1" })).toThrow(/unverified/u);
  });
});
