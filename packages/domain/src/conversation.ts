import type { AiMode } from "./channel";
import { literalGuard } from "./enum";
import { DomainValidationError } from "./errors";
import type { HumanTakeoverState } from "./human-takeover";
import type { BusinessProfileId, ChannelAccountId, ChannelIdentityId, ContactId, ConversationId, WorkspaceId } from "./ids";
import type { LeadStage } from "./lead";

export const CONVERSATION_STATUSES = ["OPEN", "CLOSED", "ARCHIVED"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];
export const isConversationStatus = literalGuard(CONVERSATION_STATUSES);

declare const stateVersionBrand: unique symbol;

/**
 * Monotonic optimistic-concurrency anchor of a conversation (DATA_MODEL.md v0.4 §5). It starts at 0 and
 * only increases, atomically with material changes that make anchored drafts, review items or follow-ups
 * stale. Phase 1 increments it when a new inbound participant message is stored and when unmatched human
 * activity starts or extends a takeover; later tasks define further triggers. Duplicate/replayed events,
 * own-echo correlation and delivery/read statuses never increment it.
 */
export type ConversationStateVersion = number & { readonly [stateVersionBrand]: true };

export function toConversationStateVersion(value: number, field = "stateVersion"): ConversationStateVersion {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DomainValidationError(field, "must be a non-negative integer");
  }
  return value as ConversationStateVersion;
}

/** An action anchored to an earlier conversation state is stale once the conversation has moved on. */
export function isStaleAnchor(anchorStateVersion: ConversationStateVersion, current: ConversationStateVersion): boolean {
  return anchorStateVersion !== current;
}

/**
 * One channel thread with one contact, inside one Business Profile. The contact, channel identity and
 * channel account all belong to the same Workspace and Business Profile as the conversation.
 */
export interface Conversation {
  readonly id: ConversationId;
  readonly workspaceId: WorkspaceId;
  readonly businessProfileId: BusinessProfileId;
  readonly channelAccountId: ChannelAccountId;
  readonly contactId: ContactId;
  readonly channelIdentityId: ChannelIdentityId;
  /** Per-conversation mode override; falls back to the channel-account/Business Profile policy when absent. */
  readonly modeOverride?: AiMode;
  readonly aiEnabled: boolean;
  readonly takeover: HumanTakeoverState;
  readonly leadStage: LeadStage;
  readonly status: ConversationStatus;
  readonly stateVersion: ConversationStateVersion;
  readonly lastInboundAt?: Date;
  readonly lastOutboundAt?: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
