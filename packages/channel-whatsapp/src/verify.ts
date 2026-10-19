/**
 * Webhook authenticity: the subscription handshake and the `X-Hub-Signature-256` payload signature.
 *
 * The signature is an HMAC-SHA256 of the raw request bytes with the app secret, so verification must run on
 * `RawWebhook.rawBody` — re-serializing parsed JSON changes the bytes and breaks the digest. Meta calls
 * payload validation optional; we always require it, so an unsigned POST is rejected.
 *
 * Fail closed means fail closed on configuration too: an adapter with no app secret rejects every POST
 * rather than accepting unverified customer messages, which is the one failure mode a missing secret could
 * otherwise produce silently.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import type { RawWebhook, VerificationResult } from "@omnichannel/channel-core";

import type { ResolvedWhatsAppConfig } from "./config";

const SIGNATURE_HEADER = "x-hub-signature-256";
const SIGNATURE_PREFIX = "sha256=";

export function verifyWhatsAppWebhook(input: RawWebhook, config: ResolvedWhatsAppConfig): VerificationResult {
  if (input.method === "GET") {
    return verifySubscription(input, config);
  }
  if (config.secrets.appSecret.length === 0) {
    return { status: "REJECTED", reason: "adapter has no app secret configured" };
  }
  const header = input.headers[SIGNATURE_HEADER];
  if (header === undefined || header.length === 0) {
    return { status: "REJECTED", reason: "missing payload signature" };
  }
  if (!header.startsWith(SIGNATURE_PREFIX)) {
    return { status: "REJECTED", reason: "unsupported payload signature algorithm" };
  }
  const provided = decodeHex(header.slice(SIGNATURE_PREFIX.length));
  if (provided === undefined) {
    return { status: "REJECTED", reason: "malformed payload signature" };
  }
  const expected = createHmac("sha256", config.secrets.appSecret).update(input.rawBody).digest();
  // timingSafeEqual throws on length mismatch, so compare lengths first; both are attacker-visible anyway.
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { status: "REJECTED", reason: "payload signature mismatch" };
  }
  return { status: "VERIFIED" };
}

function verifySubscription(input: RawWebhook, config: ResolvedWhatsAppConfig): VerificationResult {
  if (input.query["hub.mode"] !== "subscribe") {
    return { status: "REJECTED", reason: "unsupported webhook handshake" };
  }
  const token = input.query["hub.verify_token"];
  const challenge = input.query["hub.challenge"];
  if (token === undefined || !constantTimeEquals(token, config.secrets.verifyToken)) {
    return { status: "REJECTED", reason: "invalid verify token" };
  }
  if (challenge === undefined || challenge.length === 0) {
    return { status: "REJECTED", reason: "missing challenge" };
  }
  // Meta expects the challenge echoed back byte for byte.
  return { status: "CHALLENGE", responseBody: challenge };
}

/** Rejects the whole string when it is not even-length hex, so a truncated digest cannot compare equal. */
function decodeHex(value: string): Buffer | undefined {
  if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(value)) {
    return undefined;
  }
  return Buffer.from(value, "hex");
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && b.length > 0 && timingSafeEqual(a, b);
}

/** Guard used before normalization: an unverified payload must never be mapped. */
export function assertVerified(result: VerificationResult): void {
  if (result.status !== "VERIFIED") {
    throw new Error("refusing to normalize an unverified WhatsApp webhook");
  }
}
