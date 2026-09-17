import { literalGuard } from "./enum";
import type { ConversationStateVersion } from "./conversation";
import type { AiDraftId, BusinessProfileId, ConversationId, MessageId, WorkspaceId } from "./ids";
import type { LeadStage } from "./lead";
import type { ReasonCode } from "./reason-codes";
import type { Confidence } from "./values";

/** Draft lifecycle (TECHNICAL_SPEC.md: PENDING -> HELD | SCHEDULED -> CLAIMED -> SENT | FAILED | ...). */
export const AI_DRAFT_STATUSES = [
  "PENDING",
  "HELD",
  "SCHEDULED",
  "CLAIMED",
  "SENT",
  "FAILED",
  "HELD_AMBIGUOUS",
  "CANCELLED_SUPERSEDED",
  "DISMISSED",
] as const;
export type AiDraftStatus = (typeof AI_DRAFT_STATUSES)[number];
export const isAiDraftStatus = literalGuard(AI_DRAFT_STATUSES);

/** Provider-neutral generation metadata persisted with every draft (AI_ORCHESTRATION.md). */
export interface ModelMetadata {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly requestId?: string;
  readonly latencyMs?: number;
}

/**
 * Semantic AI draft. Provider DTOs and the model-output schema live in `@omnichannel/application`
 * (ADR-010 amendment); this type only holds validated, mapped values.
 */
export interface AiDraft {
  readonly id: AiDraftId;
  readonly workspaceId: WorkspaceId;
  readonly businessProfileId: BusinessProfileId;
  readonly conversationId: ConversationId;
  /** Newest inbound message the draft answers; a newer inbound supersedes it. */
  readonly anchorMessageId: MessageId;
  /** Conversation state the draft was generated for; the draft is stale once the conversation moves on. */
  readonly anchorStateVersion: ConversationStateVersion;
  readonly text: string;
  readonly confidence: Confidence;
  /** Advisory only: the model can never bypass the deterministic policy engine. */
  readonly modelSuggestsSend: boolean;
  readonly needsReview: boolean;
  readonly reasonCodes: readonly ReasonCode[];
  readonly intent?: string;
  readonly suggestedLeadStage?: LeadStage;
  readonly suggestedAction?: string;
  /** Knowledge chunk IDs the draft relied on; style examples never count as factual sources. */
  readonly factualSourceIds: readonly string[];
  readonly status: AiDraftStatus;
  readonly model: ModelMetadata;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
