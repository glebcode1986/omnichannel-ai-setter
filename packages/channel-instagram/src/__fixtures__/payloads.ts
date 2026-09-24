/**
 * Test fixtures: Meta-shaped payloads and correctly signed webhooks. Test-only; never imported by runtime
 * code. Every value here is synthetic.
 */
import { createHmac } from "node:crypto";

import type { RawWebhook } from "@omnichannel/channel-core";

import type { InstagramAccountBinding, InstagramAdapterConfig } from "../config";
import type { InstagramHttpPort } from "../http";

export const APP_SECRET = "test-app-secret";
export const VERIFY_TOKEN = "test-verify-token";
export const ACCESS_TOKEN = "test-access-token";

export const BINDING: InstagramAccountBinding = {
  workspaceId: "ws_1",
  businessProfileId: "bp_1",
  channelAccountId: "ca_1",
  externalAccountId: "17841400000000001",
};

/** The customer's Instagram-scoped user ID. */
export const CUSTOMER_ID = "18000000000000002";

export function signedWebhook(body: unknown, options: { readonly secret?: string; readonly tamper?: boolean } = {}): RawWebhook {
  const raw = new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body));
  const digest = createHmac("sha256", options.secret ?? APP_SECRET).update(raw).digest("hex");
  const payload = options.tamper === true ? new TextEncoder().encode(`${typeof body === "string" ? body : JSON.stringify(body)} `) : raw;
  return {
    method: "POST",
    headers: { "x-hub-signature-256": `sha256=${digest}` },
    query: {},
    rawBody: payload,
    receivedAt: new Date("2026-09-17T12:00:00.000Z"),
  };
}

export function subscriptionWebhook(query: Readonly<Record<string, string>>): RawWebhook {
  return { method: "GET", headers: {}, query, rawBody: new Uint8Array(), receivedAt: new Date("2026-09-17T12:00:00.000Z") };
}

export const AT_MS = 1_789_000_000_000;

export function envelope(...messaging: readonly unknown[]): unknown {
  return { object: "instagram", entry: [{ id: BINDING.externalAccountId, time: AT_MS, messaging }] };
}

export const inboundText = (overrides: Record<string, unknown> = {}) => ({
  sender: { id: CUSTOMER_ID },
  recipient: { id: BINDING.externalAccountId },
  timestamp: AT_MS,
  message: { mid: "mid.inbound-1", text: "Are you open on Saturday?", ...overrides },
});

export const echo = (overrides: Record<string, unknown> = {}) => ({
  sender: { id: BINDING.externalAccountId },
  recipient: { id: CUSTOMER_ID },
  timestamp: AT_MS,
  message: { mid: "mid.echo-1", text: "We open at 10.", is_echo: true, ...overrides },
});

export const readReceipt = () => ({
  sender: { id: CUSTOMER_ID },
  recipient: { id: BINDING.externalAccountId },
  timestamp: AT_MS,
  read: { mid: "mid.inbound-1" },
});

export const reaction = (action: string, timestamp = AT_MS) => ({
  sender: { id: CUSTOMER_ID },
  recipient: { id: BINDING.externalAccountId },
  timestamp,
  reaction: { mid: "mid.inbound-1", action, emoji: "❤️" },
});

export const postback = () => ({
  sender: { id: CUSTOMER_ID },
  recipient: { id: BINDING.externalAccountId },
  timestamp: AT_MS,
  postback: { mid: "mid.postback-1", title: "Book now", payload: "BOOK_NOW" },
});

/** Scripted HTTP port; records every request so tests can assert on the wire format. */
export function scriptedHttp(results: readonly Awaited<ReturnType<InstagramHttpPort["send"]>>[]): {
  readonly port: InstagramHttpPort;
  readonly requests: Parameters<InstagramHttpPort["send"]>[0][];
} {
  const requests: Parameters<InstagramHttpPort["send"]>[0][] = [];
  let index = 0;
  return {
    requests,
    port: {
      send(request) {
        requests.push(request);
        const result = results[Math.min(index, results.length - 1)];
        index += 1;
        if (result === undefined) {
          throw new Error("scripted port has no result");
        }
        return Promise.resolve(result);
      },
    },
  };
}

export const jsonResponse = (status: number, body: unknown) => ({ kind: "RESPONSE" as const, status, body: JSON.stringify(body) });

export function testConfig(overrides: Partial<InstagramAdapterConfig> = {}): InstagramAdapterConfig {
  return {
    binding: BINDING,
    secrets: {
      appSecret: APP_SECRET,
      verifyToken: VERIFY_TOKEN,
      accessToken: () => Promise.resolve(ACCESS_TOKEN),
    },
    http: scriptedHttp([jsonResponse(200, { recipient_id: CUSTOMER_ID, message_id: "mid.sent-1" })]).port,
    ...overrides,
  };
}
