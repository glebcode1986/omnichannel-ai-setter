/**
 * Test fixtures: Cloud API-shaped payloads and correctly signed webhooks. Test-only; never imported by
 * runtime code. Every value here is synthetic — no real phone number, WABA, token or `wamid`.
 */
import { createHmac } from "node:crypto";

import type { RawWebhook } from "@omnichannel/channel-core";

import type { WhatsAppAccountBinding, WhatsAppAdapterConfig } from "../config";
import type { WhatsAppHttpPort, WhatsAppHttpResult } from "../http";

export const APP_SECRET = "test-app-secret";
export const VERIFY_TOKEN = "test-verify-token";
export const ACCESS_TOKEN = "test-access-token";

export const BINDING: WhatsAppAccountBinding = {
  workspaceId: "ws_1",
  businessProfileId: "bp_1",
  channelAccountId: "ca_1",
  phoneNumberId: "100000000000001",
  wabaId: "200000000000002",
};

/** The business's own display number, which is what a coexistence echo arrives `from`. */
export const BUSINESS_DISPLAY_NUMBER = "+15550000001";
/** The customer's `wa_id`: a phone number without punctuation, which is what WhatsApp sends. */
export const CUSTOMER_WA_ID = "15550000002";
export const CUSTOMER_NAME = "Marina";

export const AT = new Date("2026-03-01T12:00:00.000Z");
/** Unix seconds as a string, which is the only form the platform sends timestamps in. */
export const seconds = (at: Date): string => String(Math.floor(at.getTime() / 1000));

export function signedWebhook(body: unknown, options: { readonly secret?: string; readonly tamper?: boolean } = {}): RawWebhook {
  const serialized = typeof body === "string" ? body : JSON.stringify(body);
  const raw = new TextEncoder().encode(serialized);
  const digest = createHmac("sha256", options.secret ?? APP_SECRET).update(raw).digest("hex");
  // Tampering appends a byte *after* signing, which is the attack the raw-body rule exists for: the parsed
  // JSON is identical and the digest is not.
  const payload = options.tamper === true ? new TextEncoder().encode(`${serialized} `) : raw;
  return {
    method: "POST",
    headers: { "x-hub-signature-256": `sha256=${digest}` },
    query: {},
    rawBody: payload,
    receivedAt: AT,
  };
}

export function unsignedWebhook(body: unknown): RawWebhook {
  return {
    method: "POST",
    headers: {},
    query: {},
    rawBody: new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)),
    receivedAt: AT,
  };
}

export function handshake(query: Readonly<Record<string, string>>): RawWebhook {
  return { method: "GET", headers: {}, query, rawBody: new Uint8Array(), receivedAt: AT };
}

/** The webhook envelope every `messages` event arrives in. */
export function envelope(value: Readonly<Record<string, unknown>>, overrides: { readonly wabaId?: string; readonly field?: string } = {}): unknown {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: overrides.wabaId ?? BINDING.wabaId,
        changes: [
          {
            field: overrides.field ?? "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: BUSINESS_DISPLAY_NUMBER, phone_number_id: BINDING.phoneNumberId },
              ...value,
            },
          },
        ],
      },
    ],
  };
}

export function inboundText(overrides: { readonly id?: string; readonly body?: string; readonly at?: Date; readonly contextId?: string } = {}): unknown {
  return envelope({
    contacts: [{ wa_id: CUSTOMER_WA_ID, profile: { name: CUSTOMER_NAME } }],
    messages: [
      {
        from: CUSTOMER_WA_ID,
        id: overrides.id ?? "wamid.inbound1",
        timestamp: seconds(overrides.at ?? AT),
        type: "text",
        text: { body: overrides.body ?? "Are you open on Saturday?" },
        ...(overrides.contextId === undefined ? {} : { context: { from: BUSINESS_DISPLAY_NUMBER, id: overrides.contextId } }),
      },
    ],
  });
}

export function inboundMedia(
  type: "image" | "video" | "audio" | "document" | "sticker",
  overrides: { readonly id?: string; readonly mediaId?: string; readonly caption?: string; readonly voice?: boolean; readonly mimeType?: string } = {},
): unknown {
  return envelope({
    contacts: [{ wa_id: CUSTOMER_WA_ID, profile: { name: CUSTOMER_NAME } }],
    messages: [
      {
        from: CUSTOMER_WA_ID,
        id: overrides.id ?? `wamid.${type}1`,
        timestamp: seconds(AT),
        type,
        [type]: {
          id: overrides.mediaId ?? `media-${type}-1`,
          mime_type: overrides.mimeType ?? defaultMime(type),
          sha256: "0000",
          ...(overrides.caption === undefined ? {} : { caption: overrides.caption }),
          ...(overrides.voice === undefined ? {} : { voice: overrides.voice }),
          ...(type === "document" ? { filename: "invoice.pdf" } : {}),
        },
      },
    ],
  });
}

export function statusEvent(
  status: "sent" | "delivered" | "read" | "failed" | "deleted",
  overrides: { readonly id?: string; readonly at?: Date; readonly errorCode?: number } = {},
): unknown {
  return envelope({
    statuses: [
      {
        id: overrides.id ?? "wamid.outbound1",
        status,
        timestamp: seconds(overrides.at ?? AT),
        recipient_id: CUSTOMER_WA_ID,
        ...(overrides.errorCode === undefined
          ? {}
          : { errors: [{ code: overrides.errorCode, title: "Message undeliverable", message: "the recipient could not be reached" }] }),
      },
    ],
  });
}

/** A scripted HTTP port: hands back the queued results in order and records what went on the wire. */
export function scriptedHttp(results: readonly WhatsAppHttpResult[]): {
  readonly port: WhatsAppHttpPort;
  readonly requests: { url: string; body: unknown; headers: Readonly<Record<string, string>> }[];
} {
  const queued = [...results];
  const requests: { url: string; body: unknown; headers: Readonly<Record<string, string>> }[] = [];
  return {
    requests,
    port: {
      send(request) {
        requests.push({
          url: request.url,
          headers: request.headers,
          body: request.body === undefined ? undefined : JSON.parse(request.body),
        });
        return Promise.resolve(queued.shift() ?? { kind: "NO_RESPONSE", reason: "TIMEOUT", message: "no response configured" });
      },
    },
  };
}

export const accepted = (messageId = "wamid.sent1"): WhatsAppHttpResult => ({
  kind: "RESPONSE",
  status: 200,
  body: JSON.stringify({ messaging_product: "whatsapp", contacts: [{ wa_id: CUSTOMER_WA_ID }], messages: [{ id: messageId }] }),
});

export const providerError = (status: number, code: number, subcode?: number): WhatsAppHttpResult => ({
  kind: "RESPONSE",
  status,
  body: JSON.stringify({
    error: {
      message: "a provider message that may quote customer content",
      type: "OAuthException",
      code,
      ...(subcode === undefined ? {} : { error_subcode: subcode }),
      fbtrace_id: "trace-1",
    },
  }),
});

export function config(overrides: Partial<WhatsAppAdapterConfig> = {}): WhatsAppAdapterConfig {
  const http = overrides.http ?? scriptedHttp([accepted()]).port;
  return {
    binding: BINDING,
    secrets: {
      appSecret: APP_SECRET,
      verifyToken: VERIFY_TOKEN,
      accessToken: () => Promise.resolve(ACCESS_TOKEN),
    },
    http,
    ...overrides,
  };
}

function defaultMime(type: string): string {
  switch (type) {
    case "image":
      return "image/jpeg";
    case "video":
      return "video/mp4";
    case "audio":
      return "audio/ogg; codecs=opus";
    case "document":
      return "application/pdf";
    default:
      return "image/webp";
  }
}
