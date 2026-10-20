import { z } from "zod";

import type { ChannelAdapter, ChannelCapabilities, NormalizedChannelEvent } from "../contracts";
import { parseNormalizedChannelEvents } from "../schemas";
import { assertVerified, decodeJsonBody, openWindowExpiry, verifyFixtureWebhook, type FixtureAdapterConfig } from "./support";

/** Simplified WhatsApp Cloud API-like webhook body. Provider field names stay inside the adapter. */
const whatsappPayloadSchema = z.object({
  object: z.literal("whatsapp_business_account"),
  entry: z.array(
    z.object({
      changes: z.array(
        z.object({
          field: z.string(),
          value: z.object({
            contacts: z.array(z.object({ wa_id: z.string(), profile: z.object({ name: z.string() }).optional() })).optional(),
            messages: z
              .array(
                z.object({
                  from: z.string(),
                  id: z.string(),
                  timestamp: z.string(),
                  type: z.string(),
                  text: z.object({ body: z.string() }).optional(),
                  context: z.object({ id: z.string() }).optional(),
                }),
              )
              .optional(),
            statuses: z
              .array(
                z.object({
                  id: z.string(),
                  status: z.enum(["sent", "delivered", "read", "failed"]),
                  timestamp: z.string(),
                  recipient_id: z.string(),
                  errors: z.array(z.object({ code: z.number(), title: z.string() })).optional(),
                }),
              )
              .optional(),
          }),
        }),
      ),
    }),
  ),
});

type WhatsappChangeValue = z.infer<typeof whatsappPayloadSchema>["entry"][number]["changes"][number]["value"];

export const WHATSAPP_FIXTURE_CAPABILITIES: ChannelCapabilities = {
  text: true,
  image: true,
  video: true,
  audio: true,
  document: true,
  interactive: true,
  templates: true,
  reactions: true,
  readReceipts: true,
  typingIndicator: true,
  // Coexistence fixture: the business app's own sends arrive on `smb_message_echoes`.
  nativeOutboundVisible: true,
};

export function createWhatsappFixtureAdapter(config: FixtureAdapterConfig): ChannelAdapter {
  return {
    channel: "WHATSAPP",

    verifyWebhook(input) {
      return Promise.resolve(verifyFixtureWebhook(input, config));
    },

    async normalizeWebhook(input) {
      assertVerified(await this.verifyWebhook(input));
      const payload = whatsappPayloadSchema.parse(decodeJsonBody(input.rawBody));
      const events = payload.entry.flatMap((entry) =>
        entry.changes.filter((change) => change.field === "messages").flatMap((change) => normalizeValue(change.value, config)),
      );
      return parseNormalizedChannelEvents(events);
    },

    getCapabilities() {
      return Promise.resolve(WHATSAPP_FIXTURE_CAPABILITIES);
    },

    evaluateWindow(ctx) {
      const expiresAt = openWindowExpiry(ctx);
      return Promise.resolve(expiresAt === undefined ? { state: "TEMPLATE_ONLY" } : { state: "OPEN_FREEFORM", expiresAt });
    },

    send(command) {
      return Promise.resolve(config.transport(command));
    },
  };
}

function normalizeValue(value: WhatsappChangeValue, config: FixtureAdapterConfig): NormalizedChannelEvent[] {
  const base = {
    workspaceId: config.workspaceId,
    businessProfileId: config.businessProfileId,
    channel: "WHATSAPP",
    channelAccountId: config.channelAccountId,
  } as const;
  const events: NormalizedChannelEvent[] = [];

  for (const message of value.messages ?? []) {
    events.push({
      ...base,
      type: "INBOUND_MESSAGE",
      sourceEventId: message.id,
      occurredAt: fromUnixSeconds(message.timestamp),
      senderExternalId: message.from,
      senderDisplayName: value.contacts?.find((contact) => contact.wa_id === message.from)?.profile?.name,
      externalMessageId: message.id,
      messageKind: message.type === "text" ? "TEXT" : "UNKNOWN",
      text: message.text?.body,
      media: [],
      replyToExternalMessageId: message.context?.id,
    });
  }

  for (const status of value.statuses ?? []) {
    const common = {
      ...base,
      sourceEventId: `status:${status.id}:${status.status}`,
      occurredAt: fromUnixSeconds(status.timestamp),
      platformMessageId: status.id,
    };
    if (status.status === "read") {
      events.push({ ...common, type: "READ_STATUS", readerExternalId: status.recipient_id });
      continue;
    }
    const error = status.errors?.[0];
    events.push({
      ...common,
      type: "DELIVERY_STATUS",
      status: status.status === "sent" ? "SENT" : status.status === "delivered" ? "DELIVERED" : "FAILED",
      error: error === undefined ? undefined : { code: String(error.code), message: error.title },
    });
  }

  return events;
}

function fromUnixSeconds(seconds: string): Date {
  return new Date(Number(seconds) * 1000);
}
