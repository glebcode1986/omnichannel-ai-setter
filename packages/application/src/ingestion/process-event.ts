import type {
  DeliveryStatusEvent,
  InboundMessageEvent,
  NormalizedChannelEvent,
  OutboundEchoEvent,
  ReadStatusEvent,
} from "@omnichannel/channel-core";
import { assertNever, type DurationRangeMs } from "@omnichannel/domain";

import type { IngestionOutcome, IngestionTransaction } from "./ports";
import { isEligibleForInboundDebounce, nextDeliveryStatus, sampleDelayMs } from "./rules";

export interface EventProcessingContext {
  readonly correlationId: string;
  readonly debounceWindowMs: DurationRangeMs;
  readonly takeoverPauseMs: number;
  readonly random: () => number;
}

export type EventProcessingResult =
  | { readonly status: "DUPLICATE" }
  | { readonly status: "PROCESSED"; readonly outcome: IngestionOutcome; readonly outboxEntryId?: string };

/**
 * Applies one verified, normalized event inside a transaction. The source-event claim comes first, so a
 * redelivered event changes nothing and cannot start a second reply cycle.
 */
export async function processEvent(
  tx: IngestionTransaction,
  event: NormalizedChannelEvent,
  context: EventProcessingContext,
): Promise<EventProcessingResult> {
  const key = {
    workspaceId: event.workspaceId,
    businessProfileId: event.businessProfileId,
    channelAccountId: event.channelAccountId,
    sourceEventId: event.sourceEventId,
  };
  const claim = await tx.claimSourceEvent({
    ...key,
    eventType: event.type,
    occurredAt: event.occurredAt,
    correlationId: context.correlationId,
  });
  if (claim === "DUPLICATE") {
    return { status: "DUPLICATE" };
  }

  let result: { outcome: IngestionOutcome; outboxEntryId?: string };
  switch (event.type) {
    case "INBOUND_MESSAGE":
      result = await applyInboundMessage(tx, event, context);
      break;
    case "OUTBOUND_ECHO":
      result = { outcome: await applyOutboundEcho(tx, event, context) };
      break;
    case "DELIVERY_STATUS":
    case "READ_STATUS":
      result = { outcome: await applyStatus(tx, event) };
      break;
    case "REACTION":
    case "POSTBACK":
    case "CONVERSATION_POLICY":
      // Recorded for audit and idempotency; handled by later tasks.
      result = { outcome: "IGNORED_UNSUPPORTED" };
      break;
    default:
      return assertNever(event, "event");
  }

  await tx.completeSourceEvent({ ...key, outcome: result.outcome });
  return { status: "PROCESSED", ...result };
}

async function applyInboundMessage(
  tx: IngestionTransaction,
  event: InboundMessageEvent,
  context: EventProcessingContext,
): Promise<{ outcome: IngestionOutcome; outboxEntryId?: string }> {
  const scope = { workspaceId: event.workspaceId, businessProfileId: event.businessProfileId, channelAccountId: event.channelAccountId };
  const identity = await tx.ensureChannelIdentity({
    ...scope,
    externalUserId: event.senderExternalId,
    displayName: event.senderDisplayName,
    username: event.senderUsername,
  });
  const conversation = await tx.ensureConversation({ ...scope, ...identity });
  const message = await tx.insertMessage({
    ...scope,
    conversationId: conversation.conversationId,
    direction: "IN",
    source: "PARTICIPANT",
    channelMessageId: event.externalMessageId,
    kind: event.messageKind,
    text: event.text,
    media: event.media.map((media) => ({
      kind: media.kind,
      providerMediaId: media.providerMediaId,
      mimeType: media.mimeType,
      caption: media.caption,
    })),
    replyToChannelMessageId: event.replyToExternalMessageId,
    occurredAt: event.occurredAt,
  });
  if (message === undefined) {
    // Same platform message under a different source event ID: already stored, no second reply cycle.
    return { outcome: "INBOUND_DUPLICATE_MESSAGE" };
  }
  await tx.recordActivity({
    workspaceId: event.workspaceId,
    businessProfileId: event.businessProfileId,
    conversationId: conversation.conversationId,
    direction: "IN",
    occurredAt: event.occurredAt,
  });

  if (!isEligibleForInboundDebounce(conversation)) {
    return { outcome: "INBOUND_STORED" };
  }
  const entry = await tx.addOutboxEntry({
    workspaceId: event.workspaceId,
    businessProfileId: event.businessProfileId,
    kind: "INBOUND_DEBOUNCE",
    dedupeKey: ["inbound-debounce", event.workspaceId, event.businessProfileId, conversation.conversationId, message.messageId].join(":"),
    correlationId: context.correlationId,
    delayMs: sampleDelayMs(context.debounceWindowMs, context.random),
    payload: {
      schemaVersion: 1,
      workspaceId: event.workspaceId,
      businessProfileId: event.businessProfileId,
      correlationId: context.correlationId,
      channelAccountId: event.channelAccountId,
      conversationId: conversation.conversationId,
      anchorMessageId: message.messageId,
      anchorInboundAt: event.occurredAt.toISOString(),
    },
  });
  return { outcome: "INBOUND_STORED", ...(entry === undefined ? {} : { outboxEntryId: entry.id }) };
}

/**
 * ADR-013: an echo correlated to an app-originated send by platform message ID is our own; anything else
 * is native/manual human activity and pauses automation. Text equality is never used.
 */
async function applyOutboundEcho(
  tx: IngestionTransaction,
  event: OutboundEchoEvent,
  context: EventProcessingContext,
): Promise<IngestionOutcome> {
  const scope = { workspaceId: event.workspaceId, businessProfileId: event.businessProfileId, channelAccountId: event.channelAccountId };
  if (await tx.isAppOriginatedMessage({ ...scope, platformMessageId: event.platformMessageId })) {
    return "OWN_ECHO";
  }

  const identity = await tx.ensureChannelIdentity({ ...scope, externalUserId: event.recipientExternalId });
  const conversation = await tx.ensureConversation({ ...scope, ...identity });
  const message = await tx.insertMessage({
    ...scope,
    conversationId: conversation.conversationId,
    direction: "OUT",
    source: "HUMAN",
    channelMessageId: event.platformMessageId,
    kind: event.messageKind,
    text: event.text,
    media: [],
    deliveryStatus: "SENT",
    occurredAt: event.occurredAt,
  });
  if (message === undefined) {
    return "OUTBOUND_DUPLICATE_MESSAGE";
  }
  await tx.recordActivity({
    workspaceId: event.workspaceId,
    businessProfileId: event.businessProfileId,
    conversationId: conversation.conversationId,
    direction: "OUT",
    occurredAt: event.occurredAt,
  });
  await tx.startHumanTakeover({
    workspaceId: event.workspaceId,
    businessProfileId: event.businessProfileId,
    conversationId: conversation.conversationId,
    since: event.occurredAt,
    pausedUntil: new Date(event.occurredAt.getTime() + context.takeoverPauseMs),
  });
  return "HUMAN_TAKEOVER";
}

async function applyStatus(tx: IngestionTransaction, event: DeliveryStatusEvent | ReadStatusEvent): Promise<IngestionOutcome> {
  const stored = await tx.findMessageByPlatformId({
    workspaceId: event.workspaceId,
    businessProfileId: event.businessProfileId,
    channelAccountId: event.channelAccountId,
    platformMessageId: event.platformMessageId,
  });
  if (stored === undefined) {
    return "STATUS_UNMATCHED";
  }
  const next = nextDeliveryStatus(stored.deliveryStatus, event.type === "READ_STATUS" ? "READ" : event.status);
  if (next === undefined) {
    return "STATUS_UNCHANGED";
  }
  await tx.updateMessageDeliveryStatus({
    workspaceId: event.workspaceId,
    businessProfileId: event.businessProfileId,
    messageId: stored.messageId,
    deliveryStatus: next,
    occurredAt: event.occurredAt,
  });
  return "STATUS_APPLIED";
}
