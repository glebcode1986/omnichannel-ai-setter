import { assertNever, CHANNEL_CAPABILITY_KEYS } from "@omnichannel/domain";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";

import { createInstagramFixtureAdapter } from "./__fixtures__/instagram";
import { SERVICE_WINDOW_MS, type FixtureAdapterConfig } from "./__fixtures__/support";
import { createWhatsappFixtureAdapter } from "./__fixtures__/whatsapp";
import {
  allowsFreeformSend,
  ContractValidationError,
  NORMALIZED_CHANNEL_EVENT_TYPES,
  OUTBOUND_CONTENT_TYPES,
  parseNormalizedChannelEvents,
  parseOutboundMessageCommand,
  parseSendResult,
  parseWindowDecision,
  SEND_OUTCOMES,
  sendDisposition,
  WINDOW_STATES,
  type ChannelAdapter,
  type NormalizedChannelEvent,
  type NormalizedChannelEventType,
  type OutboundContentType,
  type OutboundMessageCommand,
  type RawWebhook,
  type SendResult,
  type WindowDecision,
} from "./index";
import type {
  normalizedChannelEventSchema,
  outboundMessageCommandSchema,
  sendResultSchema,
  windowDecisionSchema,
} from "./schemas";

const occurredAt = new Date("2026-09-17T10:00:00.000Z");
const base = { workspaceId: "ws_1", channel: "INSTAGRAM", channelAccountId: "ca_1", occurredAt } as const;

const sampleEvents: NormalizedChannelEvent[] = [
  {
    ...base,
    type: "INBOUND_MESSAGE",
    sourceEventId: "evt_1",
    senderExternalId: "customer_1",
    externalMessageId: "mid_1",
    messageKind: "IMAGE",
    text: "caption",
    media: [{ kind: "IMAGE", providerMediaId: "media_1", mimeType: "image/jpeg", sizeBytes: 1024 }],
    replyToExternalMessageId: "mid_0",
  },
  {
    ...base,
    type: "OUTBOUND_ECHO",
    sourceEventId: "evt_2",
    platformMessageId: "mid_2",
    recipientExternalId: "customer_1",
    messageKind: "TEXT",
    text: "hello",
  },
  {
    ...base,
    channel: "WHATSAPP",
    type: "DELIVERY_STATUS",
    sourceEventId: "evt_3",
    platformMessageId: "wamid_2",
    status: "FAILED",
    error: { code: "131047", message: "re-engagement required" },
  },
  { ...base, type: "READ_STATUS", sourceEventId: "evt_4", readerExternalId: "customer_1", platformMessageId: "mid_2" },
  {
    ...base,
    type: "REACTION",
    sourceEventId: "evt_5",
    platformMessageId: "mid_2",
    reactorExternalId: "customer_1",
    action: "REACT",
    reaction: "love",
  },
  { ...base, type: "POSTBACK", sourceEventId: "evt_6", senderExternalId: "customer_1", payload: "BOOK_CALL" },
  {
    ...base,
    channel: "WHATSAPP",
    type: "CONVERSATION_POLICY",
    sourceEventId: "evt_7",
    change: "OPTED_OUT",
    participantExternalId: "customer_1",
  },
];

type VariantKeys<Union, Tag extends PropertyKey> = {
  [Value in Union extends Record<Tag, infer V extends PropertyKey> ? V : never]: keyof Extract<Union, Record<Tag, Value>>;
};

describe("runtime schemas", () => {
  it("stay in lock-step with the contract types, key for key", () => {
    expectTypeOf<VariantKeys<z.output<typeof normalizedChannelEventSchema>, "type">>().toEqualTypeOf<
      VariantKeys<NormalizedChannelEvent, "type">
    >();
    expectTypeOf<VariantKeys<z.output<typeof windowDecisionSchema>, "state">>().toEqualTypeOf<
      VariantKeys<WindowDecision, "state">
    >();
    expectTypeOf<VariantKeys<z.output<typeof sendResultSchema>, "outcome">>().toEqualTypeOf<
      VariantKeys<SendResult, "outcome">
    >();
    expectTypeOf<keyof z.output<typeof outboundMessageCommandSchema>>().toEqualTypeOf<keyof OutboundMessageCommand>();
    expectTypeOf<VariantKeys<z.output<typeof outboundMessageCommandSchema>["content"], "type">>().toEqualTypeOf<
      VariantKeys<OutboundMessageCommand["content"], "type">
    >();
  });
});

describe("normalized channel events", () => {
  it("discriminates every event variant exhaustively", () => {
    const route = (event: NormalizedChannelEvent): string => {
      switch (event.type) {
        case "INBOUND_MESSAGE":
          return `inbound:${event.messageKind}`;
        case "OUTBOUND_ECHO":
          return `echo:${event.platformMessageId}`;
        case "DELIVERY_STATUS":
          return `delivery:${event.status}`;
        case "READ_STATUS":
          return `read:${event.platformMessageId}`;
        case "REACTION":
          return `reaction:${event.action}`;
        case "POSTBACK":
          return `postback:${event.payload}`;
        case "CONVERSATION_POLICY":
          return `policy:${event.change}`;
        default:
          return assertNever(event, "event");
      }
    };

    expect(sampleEvents.map(route)).toEqual([
      "inbound:IMAGE",
      "echo:mid_2",
      "delivery:FAILED",
      "read:mid_2",
      "reaction:REACT",
      "postback:BOOK_CALL",
      "policy:OPTED_OUT",
    ]);
    expect(sampleEvents.map((event) => event.type)).toEqual([...NORMALIZED_CHANNEL_EVENT_TYPES]);
    expectTypeOf<(typeof NORMALIZED_CHANNEL_EVENT_TYPES)[number]>().toEqualTypeOf<NormalizedChannelEventType>();
    expect(() => route({ ...sampleEvents[0], type: "TYPING" } as unknown as NormalizedChannelEvent)).toThrow();
  });

  it("accepts valid normalized payloads", () => {
    expect(parseNormalizedChannelEvents(sampleEvents)).toEqual(sampleEvents);
    expect(parseNormalizedChannelEvents([])).toEqual([]);
  });

  it.each<[string, unknown, string]>([
    ["unknown event type", [{ ...sampleEvents[0], type: "TYPING" }], "0.type"],
    ["missing source event id", [{ ...sampleEvents[1], sourceEventId: undefined }], "0.sourceEventId"],
    ["empty channel account id", [{ ...sampleEvents[1], channelAccountId: "" }], "0.channelAccountId"],
    ["provider field leaking past normalization", [{ ...sampleEvents[1], is_echo: true }], "0"],
    ["unsupported channel", [{ ...sampleEvents[3], channel: "THREADS" }], "0.channel"],
    ["timestamp that is not a Date", [{ ...sampleEvents[3], occurredAt: "2026-09-17T10:00:00Z" }], "0.occurredAt"],
    ["invalid Date", [{ ...sampleEvents[3], occurredAt: new Date("not a date") }], "0.occurredAt"],
    ["unknown media kind", [{ ...sampleEvents[0], media: [{ kind: "STICKER" }] }], "0.media.0.kind"],
    ["read status without a platform message id", [{ ...sampleEvents[3], platformMessageId: undefined }], "0.platformMessageId"],
    ["non-array input", { ...sampleEvents[0] }, ""],
  ])("rejects %s", (_name, input, path) => {
    const error = captureContractError(() => parseNormalizedChannelEvents(input));
    expect(error.issues.map((issue) => issue.path)).toContain(path);
  });

  it("never echoes payload values in validation errors", () => {
    const secret = "customer-secret-4111111111111111";
    const error = captureContractError(() =>
      parseNormalizedChannelEvents([{ ...sampleEvents[0], text: secret, senderExternalId: secret, messageKind: secret }]),
    );
    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(error.issues)).not.toContain(secret);
  });
});

describe("WindowDecision", () => {
  const now = new Date("2026-09-17T12:00:00.000Z");
  const decisions: WindowDecision[] = [
    { state: "OPEN_FREEFORM", expiresAt: new Date("2026-09-18T10:00:00.000Z") },
    { state: "TEMPLATE_ONLY" },
    { state: "NOT_ELIGIBLE", reason: "no user-initiated conversation" },
    { state: "UNKNOWN", reason: "provider status unavailable" },
  ];

  it("covers all variants and only allows free-form sends inside an open window", () => {
    expect(decisions.map((decision) => decision.state)).toEqual([...WINDOW_STATES]);
    expectTypeOf<(typeof WINDOW_STATES)[number]>().toEqualTypeOf<WindowDecision["state"]>();
    expect(decisions.map((decision) => parseWindowDecision(decision))).toEqual(decisions);
    expect(decisions.map((decision) => allowsFreeformSend(decision, now))).toEqual([true, false, false, false]);
    expect(allowsFreeformSend({ state: "OPEN_FREEFORM" }, now)).toBe(true);
    expect(allowsFreeformSend({ state: "OPEN_FREEFORM", expiresAt: now }, now)).toBe(false);
  });

  it("rejects malformed decisions", () => {
    for (const invalid of [
      { state: "NOT_ELIGIBLE" },
      { state: "UNKNOWN", reason: "" },
      { state: "OPEN_FREEFORM", reason: "extra" },
      { state: "CLOSED" },
      { state: "TEMPLATE_ONLY", expiresAt: "tomorrow" },
    ]) {
      expect(() => parseWindowDecision(invalid)).toThrow(ContractValidationError);
    }
  });
});

describe("SendResult", () => {
  it("never allows an ambiguous send to be retried", () => {
    const results: SendResult[] = [
      { outcome: "ACCEPTED", platformMessageId: "mid_1" },
      { outcome: "REJECTED", retryable: true, code: "RATE_LIMIT", message: "slow down" },
      { outcome: "REJECTED", retryable: false, code: "INVALID_RECIPIENT", message: "cannot message" },
      { outcome: "AMBIGUOUS", code: "TIMEOUT", message: "connection reset after request was written" },
    ];

    expect(results.map(sendDisposition)).toEqual(["COMPLETED", "RETRY_ALLOWED", "FAILED", "QUARANTINE_NO_RETRY"]);
    expect(results.map((result) => parseSendResult(result))).toEqual(results);
    expect(new Set(results.map((result) => result.outcome))).toEqual(new Set(SEND_OUTCOMES));
    expectTypeOf<(typeof SEND_OUTCOMES)[number]>().toEqualTypeOf<SendResult["outcome"]>();

    // @ts-expect-error an ambiguous outcome has no retryable flag
    const ambiguousRetry: SendResult = { outcome: "AMBIGUOUS", retryable: true, message: "timeout" };
    expect(() => parseSendResult(ambiguousRetry)).toThrow(ContractValidationError);
  });

  it("rejects malformed results", () => {
    for (const invalid of [
      { outcome: "ACCEPTED" },
      { outcome: "REJECTED", message: "missing retryable" },
      { outcome: "AMBIGUOUS" },
      { outcome: "MAYBE", message: "unknown" },
    ]) {
      expect(() => parseSendResult(invalid)).toThrow(ContractValidationError);
    }
  });
});

describe("OutboundMessageCommand", () => {
  const command: OutboundMessageCommand = {
    workspaceId: "ws_1",
    channelAccountId: "ca_1",
    conversationId: "conv_1",
    recipientExternalId: "customer_1",
    operationId: "op_1",
    content: { type: "TEXT", text: "Thanks, we will confirm shortly." },
  };

  it("accepts text and template content", () => {
    expect(parseOutboundMessageCommand(command)).toEqual(command);
    const template: OutboundMessageCommand = {
      ...command,
      content: { type: "TEMPLATE", templateName: "order_update", languageCode: "en_US", parameters: [{ name: "1", value: "42" }] },
    };
    expect(parseOutboundMessageCommand(template)).toEqual(template);
    expect([command.content.type, template.content.type]).toEqual([...OUTBOUND_CONTENT_TYPES]);
    expectTypeOf<(typeof OUTBOUND_CONTENT_TYPES)[number]>().toEqualTypeOf<OutboundContentType>();
  });

  it("rejects malformed commands", () => {
    for (const invalid of [
      { ...command, operationId: "" },
      { ...command, content: { type: "TEXT", text: "" } },
      { ...command, content: { type: "TEMPLATE", languageCode: "en_US", parameters: [] } },
      { ...command, content: { type: "IMAGE", url: "https://example.com/a.png" } },
      { ...command, providerTag: "HUMAN_AGENT" },
    ]) {
      expect(() => parseOutboundMessageCommand(invalid)).toThrow(ContractValidationError);
    }
  });
});

describe("fixture adapters", () => {
  const config: FixtureAdapterConfig = {
    workspaceId: "ws_1",
    channelAccountId: "ca_1",
    verifyToken: "verify-token",
    expectedSignature: "fixture-signature",
    transport: (command) => {
      switch (command.operationId) {
        case "op_ambiguous":
          return { outcome: "AMBIGUOUS", code: "TIMEOUT", message: "socket closed after write" };
        case "op_rejected":
          return { outcome: "REJECTED", retryable: true, code: "RATE_LIMIT", message: "throttled" };
        default:
          return { outcome: "ACCEPTED", platformMessageId: `pm_${command.operationId}` };
      }
    },
  };
  const instagram = createInstagramFixtureAdapter(config);
  const whatsapp = createWhatsappFixtureAdapter(config);
  const lastInboundAt = new Date("2026-09-17T10:00:00.000Z");
  const insideWindow = new Date(lastInboundAt.getTime() + SERVICE_WINDOW_MS - 1);
  const outsideWindow = new Date(lastInboundAt.getTime() + SERVICE_WINDOW_MS);

  const cases = [
    {
      adapter: instagram,
      body: {
        object: "instagram",
        entry: [
          {
            messaging: [
              { sender: { id: "igsid_1" }, recipient: { id: "ig_biz" }, timestamp: 1_789_725_600_000, message: { mid: "ig_mid_1", text: "How much?" } },
              {
                sender: { id: "ig_biz" },
                recipient: { id: "igsid_1" },
                timestamp: 1_789_725_660_000,
                message: { mid: "ig_mid_2", text: "Hi!", is_echo: true, app_id: "app_1" },
              },
              { sender: { id: "igsid_1" }, recipient: { id: "ig_biz" }, timestamp: 1_789_725_700_000, read: { mid: "ig_mid_2" } },
              { sender: { id: "igsid_1" }, recipient: { id: "ig_biz" }, timestamp: 1_789_725_800_000, typing: { on: true } },
            ],
          },
        ],
      },
      expectedTypes: ["INBOUND_MESSAGE", "OUTBOUND_ECHO", "READ_STATUS"],
      windowWithoutInbound: { state: "NOT_ELIGIBLE", reason: "no user-initiated conversation" },
      windowOutside: { state: "NOT_ELIGIBLE", reason: "standard messaging window closed" },
    },
    {
      adapter: whatsapp,
      body: {
        object: "whatsapp_business_account",
        entry: [
          {
            changes: [
              {
                field: "messages",
                value: {
                  contacts: [{ wa_id: "15550001111", profile: { name: "Ana" } }],
                  messages: [{ from: "15550001111", id: "wamid.in1", timestamp: "1789725600", type: "text", text: { body: "Hola" } }],
                  statuses: [
                    { id: "wamid.out1", status: "delivered", timestamp: "1789725660", recipient_id: "15550001111" },
                    {
                      id: "wamid.out2",
                      status: "failed",
                      timestamp: "1789725670",
                      recipient_id: "15550001111",
                      errors: [{ code: 131047, title: "Re-engagement message" }],
                    },
                    { id: "wamid.out1", status: "read", timestamp: "1789725680", recipient_id: "15550001111" },
                  ],
                },
              },
              { field: "account_update", value: {} },
            ],
          },
        ],
      },
      expectedTypes: ["INBOUND_MESSAGE", "DELIVERY_STATUS", "DELIVERY_STATUS", "READ_STATUS"],
      windowWithoutInbound: { state: "TEMPLATE_ONLY" },
      windowOutside: { state: "TEMPLATE_ONLY" },
    },
  ] as const;

  it("both satisfy the same ChannelAdapter contract without provider-specific members", () => {
    const adapters: readonly ChannelAdapter[] = [instagram, whatsapp];
    expect(adapters.map((adapter) => adapter.channel)).toEqual(["INSTAGRAM", "WHATSAPP"]);
    expectTypeOf<keyof ChannelAdapter>().toEqualTypeOf<
      "channel" | "verifyWebhook" | "normalizeWebhook" | "getCapabilities" | "evaluateWindow" | "send"
    >();
    for (const adapter of adapters) {
      expect(Object.keys(adapter).sort()).toEqual(
        ["channel", "evaluateWindow", "getCapabilities", "normalizeWebhook", "send", "verifyWebhook"],
      );
    }
  });

  describe.each(cases)("$adapter.channel", ({ adapter, body, expectedTypes, windowWithoutInbound, windowOutside }) => {
    const signedPost = (payload: unknown, signature = "sha256=fixture-signature"): RawWebhook => ({
      method: "POST",
      headers: { "x-hub-signature-256": signature },
      query: {},
      rawBody: asciiBytes(JSON.stringify(payload)),
      receivedAt: occurredAt,
    });

    it("answers the subscription handshake and rejects bad tokens or signatures", async () => {
      const handshake = (token: string): RawWebhook => ({
        method: "GET",
        headers: {},
        query: { "hub.mode": "subscribe", "hub.verify_token": token, "hub.challenge": "challenge-123" },
        rawBody: new Uint8Array(),
        receivedAt: occurredAt,
      });

      expect(await adapter.verifyWebhook(handshake("verify-token"))).toEqual({ status: "CHALLENGE", responseBody: "challenge-123" });
      expect((await adapter.verifyWebhook(handshake("wrong"))).status).toBe("REJECTED");
      expect((await adapter.verifyWebhook(signedPost(body, "sha256=forged"))).status).toBe("REJECTED");
      await expect(adapter.normalizeWebhook(signedPost(body, "sha256=forged"))).rejects.toThrow(/unverified/);
    });

    it("normalizes verified payloads deterministically into valid channel-neutral events", async () => {
      const first = await adapter.normalizeWebhook(signedPost(body));
      const duplicate = await adapter.normalizeWebhook(signedPost(body));

      expect(first.map((event) => event.type)).toEqual(expectedTypes);
      expect(duplicate).toEqual(first);
      expect(parseNormalizedChannelEvents(first)).toEqual(first);
      for (const event of first) {
        expect(event).toMatchObject({ workspaceId: "ws_1", channelAccountId: "ca_1", channel: adapter.channel });
      }
      expect(new Set(first.map((event) => event.sourceEventId)).size).toBe(first.length);
      await expect(adapter.normalizeWebhook(signedPost({ object: "something-else" }))).rejects.toThrow();
    });

    it("reports capabilities for every capability key", async () => {
      expect(Object.keys(await adapter.getCapabilities("ca_1")).sort()).toEqual([...CHANNEL_CAPABILITY_KEYS].sort());
    });

    it("reports channel window decisions", async () => {
      const ctx = { workspaceId: "ws_1", channelAccountId: "ca_1", conversationId: "conv_1", participantExternalId: "customer_1" };

      expect(await adapter.evaluateWindow({ ...ctx, now: insideWindow })).toEqual(windowWithoutInbound);
      expect(await adapter.evaluateWindow({ ...ctx, lastInboundAt, now: insideWindow })).toEqual({
        state: "OPEN_FREEFORM",
        expiresAt: outsideWindow,
      });
      expect(await adapter.evaluateWindow({ ...ctx, lastInboundAt, now: outsideWindow })).toEqual(windowOutside);
    });

    it("returns normalized send outcomes, including ambiguity, instead of throwing", async () => {
      const command: OutboundMessageCommand = {
        workspaceId: "ws_1",
        channelAccountId: "ca_1",
        conversationId: "conv_1",
        recipientExternalId: "customer_1",
        operationId: "op_ok",
        content: { type: "TEXT", text: "Hello" },
      };

      const outcomes = await Promise.all(
        ["op_ok", "op_rejected", "op_ambiguous"].map((operationId) => adapter.send({ ...command, operationId })),
      );
      expect(outcomes.map((result) => sendDisposition(parseSendResult(result)))).toEqual([
        "COMPLETED",
        "RETRY_ALLOWED",
        "QUARANTINE_NO_RETRY",
      ]);
    });
  });

  it("gates template content by channel capability", async () => {
    const template: OutboundMessageCommand = {
      workspaceId: "ws_1",
      channelAccountId: "ca_1",
      conversationId: "conv_1",
      recipientExternalId: "customer_1",
      operationId: "op_template",
      content: { type: "TEMPLATE", templateName: "order_update", languageCode: "en_US", parameters: [] },
    };

    expect(await instagram.send(template)).toMatchObject({ outcome: "REJECTED", retryable: false, code: "UNSUPPORTED_CONTENT" });
    expect(await whatsapp.send(template)).toEqual({ outcome: "ACCEPTED", platformMessageId: "pm_op_template" });
  });

  it("keeps the WhatsApp failed-status provider code as metadata", async () => {
    const [waCase] = cases.slice(1);
    const events = await whatsapp.normalizeWebhook({
      method: "POST",
      headers: { "x-hub-signature-256": "sha256=fixture-signature" },
      query: {},
      rawBody: asciiBytes(JSON.stringify(waCase?.body)),
      receivedAt: occurredAt,
    });
    expect(events.find((event) => event.type === "DELIVERY_STATUS" && event.status === "FAILED")).toMatchObject({
      platformMessageId: "wamid.out2",
      error: { code: "131047" },
    });
  });
});

function asciiBytes(text: string): Uint8Array {
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

function captureContractError(action: () => unknown): ContractValidationError {
  try {
    action();
  } catch (error) {
    if (error instanceof ContractValidationError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a ContractValidationError");
}
