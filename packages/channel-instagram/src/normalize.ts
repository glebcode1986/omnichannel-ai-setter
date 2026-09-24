/**
 * Provider payload -> normalized events (CHANNEL_CONTRACTS.md).
 *
 * Rules that keep this safe:
 * - scope (workspace, Business Profile, channel account) comes from the binding, never from the payload;
 * - unknown or unmappable items are skipped, so one new Meta field cannot drop a whole batch;
 * - the adapter classifies nothing: an echo is reported as an echo, and the application decides whether it
 *   was our own send or a human's (ADR-013);
 * - media we cannot interpret is reported as UNKNOWN with no invented description.
 */
import type { MediaAttachment, NormalizedChannelEvent } from "@omnichannel/channel-core";
import type { MessageKind } from "@omnichannel/domain";

import type { InstagramAccountBinding } from "./config";
import { parseEntry, parseMessagingItem, type InstagramAttachment, type InstagramMessagingItem, type InstagramWebhookBody } from "./payload";
import { sourceEventId } from "./source-event-id";

/** Meta attachment types we can represent; everything else (stickers, shares, story mentions) is UNKNOWN. */
const ATTACHMENT_KINDS: Readonly<Record<string, MediaAttachment["kind"]>> = {
  image: "IMAGE",
  video: "VIDEO",
  audio: "AUDIO",
  file: "DOCUMENT",
};

export function normalizeInstagramWebhook(body: InstagramWebhookBody, binding: InstagramAccountBinding): NormalizedChannelEvent[] {
  const events: NormalizedChannelEvent[] = [];
  for (const rawEntry of body.entry) {
    const entry = parseEntry(rawEntry);
    // A delivery may batch several accounts; this adapter speaks only for the account it is bound to, and an
    // entry that does not name an account is not evidence that it is ours.
    if (entry === undefined || entry.id !== binding.externalAccountId) {
      continue;
    }
    for (const rawItem of entry.messaging ?? []) {
      const item = parseMessagingItem(rawItem);
      const event = item === undefined ? undefined : normalizeItem(item, binding);
      if (event !== undefined) {
        events.push(event);
      }
    }
  }
  return events;
}

function normalizeItem(item: InstagramMessagingItem, binding: InstagramAccountBinding): NormalizedChannelEvent | undefined {
  const occurredAt = toOccurredAt(item.timestamp);
  const senderId = item.sender?.id;
  const recipientId = item.recipient?.id;
  if (occurredAt === undefined) {
    return undefined;
  }
  const base = {
    workspaceId: binding.workspaceId,
    businessProfileId: binding.businessProfileId,
    channel: "INSTAGRAM",
    channelAccountId: binding.channelAccountId,
    occurredAt,
  } as const;

  if (item.message !== undefined) {
    const message = item.message;
    const mid = message.mid;
    if (mid === undefined || mid.length === 0 || message.is_deleted === true) {
      // A deletion has no variant in the normalized contract; dropping it is better than inventing one.
      return undefined;
    }
    // `is_self` marks a test message to our own account, and a non-echo message from the bound account is
    // the same situation seen from the payload. Either would otherwise become a "customer" who is us.
    if (message.is_echo !== true && (message.is_self === true || senderId === binding.externalAccountId)) {
      return undefined;
    }
    const { kind, media } = describeContent(message.attachments, message.is_unsupported === true, message.text);
    if (message.is_echo === true) {
      if (recipientId === undefined) {
        return undefined;
      }
      return {
        ...base,
        type: "OUTBOUND_ECHO",
        sourceEventId: sourceEventId("echo", mid),
        platformMessageId: mid,
        // On an echo the customer is the recipient; taking the sender here would invent a contact.
        recipientExternalId: recipientId,
        messageKind: kind,
        ...(message.text === undefined ? {} : { text: message.text }),
      };
    }
    if (senderId === undefined) {
      return undefined;
    }
    const replyTo = message.reply_to?.mid;
    return {
      ...base,
      type: "INBOUND_MESSAGE",
      sourceEventId: sourceEventId("msg", mid),
      senderExternalId: senderId,
      externalMessageId: mid,
      messageKind: kind,
      ...(message.text === undefined ? {} : { text: message.text }),
      media,
      ...(replyTo === undefined ? {} : { replyToExternalMessageId: replyTo }),
    };
  }

  if (item.read !== undefined) {
    const mid = item.read.mid;
    if (mid === undefined || senderId === undefined) {
      return undefined;
    }
    return { ...base, type: "READ_STATUS", sourceEventId: sourceEventId("read", senderId, mid), readerExternalId: senderId, platformMessageId: mid };
  }

  if (item.reaction !== undefined) {
    const mid = item.reaction.mid;
    const action = item.reaction.action === "unreact" ? "UNREACT" : item.reaction.action === "react" ? "REACT" : undefined;
    if (mid === undefined || action === undefined || senderId === undefined) {
      return undefined;
    }
    const emoji = item.reaction.emoji ?? item.reaction.reaction;
    return {
      ...base,
      type: "REACTION",
      // React and unreact on one message are separate facts, so the timestamp keeps them distinct.
      sourceEventId: sourceEventId("reaction", mid, action, String(item.timestamp ?? occurredAt.getTime())),
      platformMessageId: mid,
      reactorExternalId: senderId,
      action,
      ...(emoji === undefined || emoji.length === 0 ? {} : { reaction: emoji.slice(0, 64) }),
    };
  }

  if (item.postback !== undefined) {
    const payload = item.postback.payload;
    if (payload === undefined || payload.length === 0 || senderId === undefined) {
      return undefined;
    }
    const mid = item.postback.mid;
    return {
      ...base,
      type: "POSTBACK",
      sourceEventId: sourceEventId("postback", senderId, mid ?? payload, String(item.timestamp ?? occurredAt.getTime())),
      senderExternalId: senderId,
      payload: payload.slice(0, 4_096),
      ...(item.postback.title === undefined ? {} : { title: item.postback.title }),
      ...(mid === undefined ? {} : { relatedMessageId: mid }),
    };
  }

  // Anything else (message_edit, referrals, future fields) has no normalized variant yet.
  return undefined;
}

/** Instagram timestamps are milliseconds; a missing or unusable one makes the item unusable. */
function toOccurredAt(timestamp: number | undefined): Date | undefined {
  if (timestamp === undefined || !Number.isFinite(timestamp)) {
    return undefined;
  }
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function describeContent(
  attachments: readonly InstagramAttachment[] | undefined,
  unsupported: boolean,
  text: string | undefined,
): { kind: MessageKind; media: readonly MediaAttachment[] } {
  if (unsupported) {
    // Meta told us it cannot hand the media over; we never guess what it was.
    return { kind: "UNKNOWN", media: [] };
  }
  const list = attachments ?? [];
  if (list.length === 0) {
    return text === undefined ? { kind: "UNKNOWN", media: [] } : { kind: "TEXT", media: [] };
  }
  const media: MediaAttachment[] = [];
  for (const attachment of list) {
    const kind = attachment.type === undefined ? undefined : ATTACHMENT_KINDS[attachment.type];
    if (kind !== undefined) {
      media.push({ kind });
    }
  }
  // A share, sticker or story mention has no MediaAttachment kind, so the message is reported as UNKNOWN.
  return media.length === 0 ? { kind: "UNKNOWN", media: [] } : { kind: media[0]?.kind ?? "UNKNOWN", media };
}
