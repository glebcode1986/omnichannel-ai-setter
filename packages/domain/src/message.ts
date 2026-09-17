import type { MessageKind } from "./channel";
import { literalGuard } from "./enum";
import type { BusinessProfileId, ChannelAccountId, ConversationId, MessageId, OperationId, UserId, WorkspaceId } from "./ids";

export const MESSAGE_DIRECTIONS = ["IN", "OUT"] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];
export const isMessageDirection = literalGuard(MESSAGE_DIRECTIONS);

/** Who produced the message. PARTICIPANT is the customer; HUMAN is a workspace member or a native-app reply. */
export const MESSAGE_SOURCES = ["PARTICIPANT", "AI", "HUMAN", "AUTOMATION", "SYSTEM"] as const;
export type MessageSource = (typeof MESSAGE_SOURCES)[number];
export const isMessageSource = literalGuard(MESSAGE_SOURCES);

/** Provider delivery state as reported by status webhooks; distinct from application scheduling state. */
export const MESSAGE_DELIVERY_STATUSES = ["PENDING", "SENT", "DELIVERED", "READ", "FAILED"] as const;
export type MessageDeliveryStatus = (typeof MESSAGE_DELIVERY_STATUSES)[number];
export const isMessageDeliveryStatus = literalGuard(MESSAGE_DELIVERY_STATUSES);

/**
 * Outbound transport path. HUMAN_AGENT is only ever used for an explicitly human-initiated Instagram
 * send (ADR-014); automation never selects it.
 */
export const OUTBOUND_TRANSPORT_PATHS = ["STANDARD", "HUMAN_AGENT"] as const;
export type OutboundTransportPath = (typeof OUTBOUND_TRANSPORT_PATHS)[number];
export const isOutboundTransportPath = literalGuard(OUTBOUND_TRANSPORT_PATHS);

export interface MediaReference {
  readonly kind: Extract<MessageKind, "IMAGE" | "VIDEO" | "AUDIO" | "DOCUMENT">;
  /** Provider media identifier; downloading/mirroring is a separate application concern. */
  readonly providerMediaId?: string;
  readonly mimeType?: string;
  readonly caption?: string;
}

interface MessageBase {
  readonly id: MessageId;
  readonly workspaceId: WorkspaceId;
  readonly businessProfileId: BusinessProfileId;
  readonly channelAccountId: ChannelAccountId;
  readonly conversationId: ConversationId;
  /** Stable platform message ID when the provider supplies one (unique per channel account). */
  readonly channelMessageId?: string;
  readonly kind: MessageKind;
  readonly text?: string;
  readonly media: readonly MediaReference[];
  readonly replyToChannelMessageId?: string;
  readonly occurredAt: Date;
  readonly createdAt: Date;
}

export interface InboundMessage extends MessageBase {
  readonly direction: "IN";
  readonly source: "PARTICIPANT";
}

export interface OutboundMessage extends MessageBase {
  readonly direction: "OUT";
  readonly source: Exclude<MessageSource, "PARTICIPANT">;
  readonly deliveryStatus: MessageDeliveryStatus;
  readonly transportPath: OutboundTransportPath;
  /** Operation that sent it; absent for unmatched native/manual sends observed via echo. */
  readonly operationId?: OperationId;
  /** Human who initiated the send; required for HUMAN_AGENT sends (DATA_MODEL.md). */
  readonly sentByUserId?: UserId;
}

export type Message = InboundMessage | OutboundMessage;
