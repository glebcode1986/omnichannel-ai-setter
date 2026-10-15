/**
 * Provider payload to normalized events (CHANNEL_CONTRACTS.md, WHATSAPP_ADAPTER.md).
 *
 * Three rules decide everything in this file.
 *
 * **Scope comes from the binding, never from the payload.** Every event is stamped with the workspace,
 * Business Profile and channel account of the adapter instance. The payload's `phone_number_id` is compared
 * against the binding and an event for a different asset is dropped: a webhook delivered to the wrong
 * adapter must not become another tenant's conversation.
 *
 * **Normalization is deterministic.** No clock, no randomness, no receive time in any identifier. The same
 * bytes map to the same events every time, which is what makes Meta's redeliveries safe.
 *
 * **What it cannot read, it does not guess.** An unsupported inbound type becomes an auditable event with
 * no text rather than an empty message the assistant might answer; an unreadable timestamp drops the event
 * rather than ordering it against real ones.
 */
import type {
  DeliveryStatusEvent,
  InboundMessageEvent,
  MediaAttachment,
  NormalizedChannelEvent,
  OutboundEchoEvent,
  RawWebhook,
  ReactionEvent,
  ReadStatusEvent,
} from "@omnichannel/channel-core";
import type { MessageKind } from "@omnichannel/domain";

import type { ResolvedWhatsAppConfig } from "./config";
import { parseWebhook, providerTime, type WhatsAppChangeValue, type WhatsAppMessage, type WhatsAppStatus } from "./payload";
import { sourceEventId } from "./source-event-id";

/** Media types the platform sends and this adapter can describe, mapped to the shared message kinds. */
const MEDIA_KINDS: Readonly<Record<string, Extract<MessageKind, "IMAGE" | "VIDEO" | "AUDIO" | "DOCUMENT">>> = {
  image: "IMAGE",
  video: "VIDEO",
  audio: "AUDIO",
  document: "DOCUMENT",
  // A sticker is an image as far as every downstream consumer is concerned, and calling it UNSUPPORTED
  // would hide a message a customer did send.
  sticker: "IMAGE",
};

export function normalizeWhatsAppWebhook(input: RawWebhook, config: ResolvedWhatsAppConfig): NormalizedChannelEvent[] {
  const payload = parseWebhook(input.rawBody);
  if (payload === undefined) {
    config.logger?.warn("whatsapp.webhook_unreadable", { channelAccountId: config.binding.channelAccountId });
    return [];
  }
  const events: NormalizedChannelEvent[] = [];
  for (const entry of payload.entry ?? []) {
    // `entry.id` is the WABA. A payload for another WABA reaching this adapter is a routing fault, and
    // normalizing it would attribute one business's messages to another.
    if (entry.id !== undefined && entry.id !== config.binding.wabaId) {
      config.logger?.warn("whatsapp.foreign_waba", { channelAccountId: config.binding.channelAccountId });
      continue;
    }
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (value === undefined) {
        continue;
      }
      if (change.field !== undefined && change.field !== "messages") {
        // Template status, quality rating and account updates arrive on other fields. They are real events
        // that later tasks consume; this adapter records that it saw one rather than pretending otherwise.
        config.logger?.info("whatsapp.unhandled_field", { channelAccountId: config.binding.channelAccountId, field: change.field });
        continue;
      }
      if (!belongsToThisAsset(value, config)) {
        config.logger?.warn("whatsapp.foreign_phone_number", { channelAccountId: config.binding.channelAccountId });
        continue;
      }
      for (const message of value.messages ?? []) {
        const event = normalizeMessage(message, value, config);
        if (event !== undefined) {
          events.push(event);
        }
      }
      for (const status of value.statuses ?? []) {
        const event = normalizeStatus(status, config);
        if (event !== undefined) {
          events.push(event);
        }
      }
    }
  }
  return events;
}

/**
 * Whether this change describes the asset this adapter is bound to.
 *
 * An absent `phone_number_id` is accepted: the field is documented but the adapter is bound to exactly one
 * asset by the route that resolved it, so "unstated" means "this one". A *different* one is refused.
 */
function belongsToThisAsset(value: WhatsAppChangeValue, config: ResolvedWhatsAppConfig): boolean {
  const asset = value.metadata?.phone_number_id;
  return asset === undefined || asset === config.binding.phoneNumberId;
}

function normalizeMessage(
  message: WhatsAppMessage,
  value: WhatsAppChangeValue,
  config: ResolvedWhatsAppConfig,
): InboundMessageEvent | OutboundEchoEvent | ReactionEvent | undefined {
  const platformMessageId = message.id;
  const occurredAt = providerTime(message.timestamp);
  if (platformMessageId === undefined || occurredAt === undefined) {
    // Without a stable ID there is no dedupe key, and without a platform timestamp there is no place in
    // the thread. Either one missing makes the event unusable rather than partly usable.
    config.logger?.warn("whatsapp.message_unidentifiable", { channelAccountId: config.binding.channelAccountId });
    return undefined;
  }
  const base = {
    ...scopeOf(config),
    occurredAt,
    rawMeta: message,
  };

  if (message.type === "reaction") {
    const target = message.reaction?.message_id;
    const reactor = message.from;
    if (target === undefined || reactor === undefined) {
      return undefined;
    }
    return {
      ...base,
      type: "REACTION",
      sourceEventId: sourceEventId("reaction", platformMessageId, target, reactor),
      platformMessageId: target,
      reactorExternalId: reactor,
      // WhatsApp signals removal by an empty emoji rather than by a separate event.
      action: message.reaction?.emoji === undefined || message.reaction.emoji === "" ? "UNREACT" : "REACT",
      ...(message.reaction?.emoji === undefined || message.reaction.emoji === "" ? {} : { reaction: message.reaction.emoji }),
    } satisfies ReactionEvent;
  }

  // Coexistence: a message the business itself sent from the WhatsApp Business App arrives here with the
  // business's own number as the sender. It is an echo, not a customer message, and the application
  // correlates it against stored sends to decide whether a human took over (ADR-013). Deciding that here
  // would be this adapter guessing at takeover, which is not its job.
  if (message.from !== undefined && message.from === value.metadata?.display_phone_number) {
    const recipient = value.contacts?.[0]?.wa_id;
    return {
      ...base,
      type: "OUTBOUND_ECHO",
      sourceEventId: sourceEventId("echo", platformMessageId),
      platformMessageId,
      recipientExternalId: recipient ?? "",
      messageKind: kindOf(message),
      ...(textOf(message) === undefined ? {} : { text: textOf(message) }),
    } satisfies OutboundEchoEvent;
  }

  const sender = message.from;
  if (sender === undefined) {
    config.logger?.warn("whatsapp.message_without_sender", { channelAccountId: config.binding.channelAccountId });
    return undefined;
  }
  const contact = value.contacts?.find((entry) => entry.wa_id === sender) ?? value.contacts?.[0];
  const media = mediaOf(message);
  const text = textOf(message);
  return {
    ...base,
    type: "INBOUND_MESSAGE",
    sourceEventId: sourceEventId("msg", platformMessageId),
    senderExternalId: sender,
    ...(contact?.profile?.name === undefined ? {} : { senderDisplayName: contact.profile.name }),
    externalMessageId: platformMessageId,
    messageKind: kindOf(message),
    ...(text === undefined ? {} : { text }),
    media,
    ...(message.context?.id === undefined ? {} : { replyToExternalMessageId: message.context.id }),
  } satisfies InboundMessageEvent;
}

/**
 * Status events, by platform message ID.
 *
 * Arrival order is explicitly not chronological on this platform, so nothing here compares events to each
 * other: each one carries the provider's own timestamp and the application decides precedence. An adapter
 * that dropped a `sent` because a `delivered` had already arrived would be making that decision with less
 * information than the application has.
 */
function normalizeStatus(status: WhatsAppStatus, config: ResolvedWhatsAppConfig): DeliveryStatusEvent | ReadStatusEvent | undefined {
  const platformMessageId = status.id;
  const occurredAt = providerTime(status.timestamp);
  const state = status.status;
  if (platformMessageId === undefined || occurredAt === undefined || state === undefined) {
    config.logger?.warn("whatsapp.status_unidentifiable", { channelAccountId: config.binding.channelAccountId });
    return undefined;
  }
  const base = { ...scopeOf(config), occurredAt, rawMeta: status };

  if (state === "read") {
    return {
      ...base,
      type: "READ_STATUS",
      sourceEventId: sourceEventId("read", platformMessageId),
      readerExternalId: status.recipient_id ?? "",
      platformMessageId,
    } satisfies ReadStatusEvent;
  }

  const delivery = state === "sent" ? "SENT" : state === "delivered" ? "DELIVERED" : state === "failed" ? "FAILED" : undefined;
  if (delivery === undefined) {
    // `deleted` and anything Meta adds later. Recorded rather than mapped onto a status it is not.
    config.logger?.info("whatsapp.unhandled_status", { channelAccountId: config.binding.channelAccountId, status: state });
    return undefined;
  }
  const error = status.errors?.[0];
  return {
    ...base,
    type: "DELIVERY_STATUS",
    // The state is part of the key: one message produces sent, delivered and failed, and they must not
    // deduplicate onto each other.
    sourceEventId: sourceEventId("status", platformMessageId, delivery),
    platformMessageId,
    status: delivery,
    ...(error === undefined
      ? {}
      : {
          error: {
            ...(error.code === undefined ? {} : { code: String(error.code) }),
            ...(error.title === undefined ? {} : { message: error.title }),
          },
        }),
  } satisfies DeliveryStatusEvent;
}

function scopeOf(config: ResolvedWhatsAppConfig) {
  return {
    workspaceId: config.binding.workspaceId,
    businessProfileId: config.binding.businessProfileId,
    channel: "WHATSAPP" as const,
    channelAccountId: config.binding.channelAccountId,
  };
}

/**
 * The shared message kind. Anything this adapter cannot render is UNKNOWN rather than guessed at.
 *
 * A button or list reply is INTERACTIVE rather than TEXT even though its title normalizes as text: the
 * customer chose from options the business offered, and a draft engine answering "Yes" to an open question
 * is a different situation from answering a tap on a button.
 */
function kindOf(message: WhatsAppMessage): MessageKind {
  if (message.type === "text") {
    return "TEXT";
  }
  if (message.type === "button" || message.type === "interactive") {
    return "INTERACTIVE";
  }
  const media = message.type === undefined ? undefined : MEDIA_KINDS[message.type];
  return media ?? "UNKNOWN";
}

/**
 * The customer's words, wherever the platform put them.
 *
 * A caption is text: a photo of a receipt captioned "is this the right one?" is a question, and reading
 * only `text.body` would hand the assistant an image with nothing to answer.
 */
function textOf(message: WhatsAppMessage): string | undefined {
  const candidates = [
    message.text?.body,
    message.image?.caption,
    message.video?.caption,
    message.document?.caption,
    message.audio?.caption,
    message.button?.text,
    message.interactive?.button_reply?.title,
    message.interactive?.list_reply?.title,
  ];
  const text = candidates.find((value) => value !== undefined && value.trim() !== "");
  return text === undefined ? undefined : text;
}

function mediaOf(message: WhatsAppMessage): readonly MediaAttachment[] {
  const sources: readonly (readonly [string, WhatsAppMessage["image"]])[] = [
    ["image", message.image],
    ["video", message.video],
    ["audio", message.audio],
    ["document", message.document],
    ["sticker", message.sticker],
  ];
  const attachments: MediaAttachment[] = [];
  for (const [type, object] of sources) {
    const kind = MEDIA_KINDS[type];
    if (object === undefined || kind === undefined) {
      continue;
    }
    attachments.push({
      kind,
      ...(object.id === undefined ? {} : { providerMediaId: object.id }),
      ...(object.mime_type === undefined ? {} : { mimeType: object.mime_type }),
      ...(object.caption === undefined ? {} : { caption: object.caption }),
    });
  }
  return attachments;
}
