import type { AiMode } from "./channel";
import { literalGuard } from "./enum";
import type { HumanTakeoverState } from "./human-takeover";
import type { ChannelAccountId, ContactIdentityId, ConversationId, WorkspaceId } from "./ids";
import type { LeadStage } from "./lead";

export const CONVERSATION_STATUSES = ["OPEN", "CLOSED", "ARCHIVED"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];
export const isConversationStatus = literalGuard(CONVERSATION_STATUSES);

/** A conversation between one channel account and one contact identity. */
export interface Conversation {
  readonly id: ConversationId;
  readonly workspaceId: WorkspaceId;
  readonly channelAccountId: ChannelAccountId;
  readonly contactIdentityId: ContactIdentityId;
  /** Per-conversation mode override; falls back to the account/workspace policy when absent. */
  readonly modeOverride?: AiMode;
  readonly aiEnabled: boolean;
  readonly takeover: HumanTakeoverState;
  readonly leadStage: LeadStage;
  readonly status: ConversationStatus;
  readonly lastInboundAt?: Date;
  readonly lastOutboundAt?: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
