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
  | {
      readonly status: "PROCESSED";
      readonly outcome: IngestionOutcome;
      /**
       * Every outbox entry this event wrote, so the caller can dispatch all of them now.
       *
       * Plural since Issue #21: one inbound message can owe both a reply cycle and a reading of its
       * recording. While this named only the debounce entry, the reading was left to the sweeper — up to
       * five seconds behind a draft job that went out immediately, so the draft that needed the words
       * usually ran before they existed and held the reply for a person on a reading that had worked.
       */
      readonly outboxEntryIds?: readonly string[];
    };

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

  let result: { outcome: IngestionOutcome; outboxEntryIds?: readonly string[] };
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

/**
 * Queues a reading for every recording this message carries (Issue #21).
 *
 * Runs before the debounce check on purpose, so it happens whatever the conversation's automation state.
 * A voice note in a conversation a person has taken over still needs reading — more so, because the
 * person is the one about to answer it, and the Inbox has nothing to show them otherwise.
 *
 * Audio only. Images and documents are stored and left alone: reading them is a different capability with
 * a different provider and different risks, and queueing work nothing performs would be a queue of jobs
 * that always fail.
 *
 * Both writes are in the caller's transaction, so a message is never stored without the record that its
 * recording is owed a reading, and the dedupe key makes a redelivered webhook a no-op rather than a
 * second reading of the same words.
 */
async function scheduleTranscription(
  tx: IngestionTransaction,
  event: InboundMessageEvent,
  context: EventProcessingContext,
  message: { readonly conversationId: string; readonly messageId: string },
): Promise<string | undefined> {
  const recordings = event.media.filter(
    (media): media is typeof media & { readonly providerMediaId: string } => media.kind === "AUDIO" && media.providerMediaId !== undefined,
  );
  if (recordings.length === 0) {
    return undefined;
  }
  await tx.recordPendingTranscripts({
    workspaceId: event.workspaceId,
    businessProfileId: event.businessProfileId,
    messageId: message.messageId,
    media: recordings.map((media) => ({
      providerMediaId: media.providerMediaId,
      ...(media.mimeType === undefined ? {} : { mimeType: media.mimeType }),
      ...(media.sizeBytes === undefined ? {} : { sizeBytes: media.sizeBytes }),
    })),
  });
  const entry = await tx.addOutboxEntry({
    workspaceId: event.workspaceId,
    businessProfileId: event.businessProfileId,
    kind: "MEDIA_TRANSCRIPTION",
    dedupeKey: ["media-transcription", event.workspaceId, event.businessProfileId, message.messageId].join(":"),
    correlationId: context.correlationId,
    // No delay: a reading is not a reply, so nothing about human-like timing applies to it, and the
    // sooner it lands the more likely the draft that needs it finds it already there.
    delayMs: 0,
    payload: {
      schemaVersion: 1,
      workspaceId: event.workspaceId,
      businessProfileId: event.businessProfileId,
      correlationId: context.correlationId,
      channelAccountId: event.channelAccountId,
      conversationId: message.conversationId,
      messageId: message.messageId,
    },
  });
  return entry?.id;
}

async function applyInboundMessage(
  tx: IngestionTransaction,
  event: InboundMessageEvent,
  context: EventProcessingContext,
): Promise<{ outcome: IngestionOutcome; outboxEntryIds?: readonly string[] }> {
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

  const transcription = await scheduleTranscription(tx, event, context, {
    conversationId: conversation.conversationId,
    messageId: message.messageId,
  });
  // Carried out of here even when no reply cycle follows, so a voice note in a conversation a person has
  // taken over is read now rather than when the sweeper next runs.
  const transcriptionIds = transcription === undefined ? [] : [transcription];

  if (!isEligibleForInboundDebounce(conversation)) {
    return { outcome: "INBOUND_STORED", outboxEntryIds: transcriptionIds };
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
  return { outcome: "INBOUND_STORED", outboxEntryIds: entry === undefined ? transcriptionIds : [...transcriptionIds, entry.id] };
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
