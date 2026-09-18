/**
 * Provider-neutral reply generation ports (ADR-010 as amended, AI_ORCHESTRATION.md).
 *
 * Two properties are enforced by these types rather than by documentation:
 *
 * - **The model has no reach.** The port has one method that takes data and returns data. There is no tool
 *   list, no callback, no channel account and no recipient anywhere in the request or the result, so a
 *   model's output cannot become a send: nothing here is assignable to an outbound command.
 * - **Untrusted text stays data.** The request is a typed tree of labelled segments, never a rendered
 *   prompt string. Only `packages/ai` turns segments into provider messages, so no application code can
 *   accidentally concatenate customer text into system instructions.
 */
import type { ChannelType } from "@omnichannel/channel-core";
import type { AiMode, ReasonCode } from "@omnichannel/domain";

import type { SuppliedRetrieval } from "../retrieval/ports";

/** Where the generation happens; the Business Profile is the customer-data boundary. */
export interface GenerationScope {
  readonly workspaceId: string;
  readonly businessProfileId: string;
  readonly conversationId: string;
}

export type SegmentKind = "INBOUND" | "OUTBOUND" | "NOTE";

/** Untrusted text with its origin. `text` is the only free-form field, and it is never an instruction. */
export interface ConversationSegment {
  readonly kind: SegmentKind;
  /** Stable identifier of where this came from, for audit; never shown to the model as authority. */
  readonly provenance: string;
  readonly text: string;
  readonly occurredAt: Date;
}

/**
 * A retrieved knowledge chunk. Only these may back a factual claim.
 *
 * Just the citable ID and the text: document title and version are audit data, kept in the draft's
 * retrieval record, not sent to the model. A fence header carries IDs only, so nothing business-authored
 * or customer-authored can reach the line that delimits untrusted data.
 */
export interface KnowledgeSegment {
  readonly chunkId: string;
  readonly text: string;
}

/**
 * A human-written example used for tone. Deliberately a different type from knowledge: style can never
 * satisfy a factual requirement, and keeping the types apart makes that structural.
 */
export interface StyleSegment {
  readonly exampleId: string;
  readonly text: string;
}

export interface ReplyGenerationRequest {
  readonly scope: GenerationScope;
  readonly anchorMessageId: string;
  readonly anchorStateVersion: number;
  /** Versions travel with the request and are persisted with the draft. */
  readonly promptVersion: string;
  readonly schemaVersion: string;
  /** Per-request marker that fences untrusted blocks; regenerated if it appears inside the data itself. */
  readonly nonce: string;
  readonly timeoutMs: number;
  /** Trusted configuration written by the business, not by a customer. */
  readonly persona: string;
  readonly channel: ChannelType;
  readonly capabilityHints: readonly string[];
  readonly inbound: readonly ConversationSegment[];
  readonly history: readonly ConversationSegment[];
  readonly knowledge: readonly KnowledgeSegment[];
  readonly style: readonly StyleSegment[];
  /** Present only on the single repair attempt; carries issue paths and codes, never model prose. */
  readonly repair?: {
    readonly issues: readonly { readonly path: string; readonly code: string }[];
    /** The previous, invalid output, re-supplied as untrusted data. */
    readonly previousOutput: string;
  };
}

/** Normalized provider usage. Absent fields mean the provider did not report them. */
export interface ModelUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
}

export interface ReplyGenerationResult {
  /**
   * Whatever the provider produced, unvalidated. The application owns the boundary schema, so a provider
   * implementation can never decide that its own output is acceptable.
   */
  readonly output: unknown;
  readonly provider: string;
  /** The model the provider says actually ran, not the alias that was requested. */
  readonly model: string;
  readonly requestId?: string;
  readonly usage?: ModelUsage;
  readonly latencyMs: number;
  /** Set when the provider refused or truncated; such a result is never parsed or retried. */
  readonly rejection?: "REFUSAL" | "TRUNCATED" | "UNREADABLE";
}

export class ReplyModelUnavailableError extends Error {
  constructor(reason: string) {
    // Reasons name the class of failure only: provider messages can quote the prompt.
    super(`reply model unavailable: ${reason}`);
    this.name = "ReplyModelUnavailableError";
  }
}

/** Implemented in `packages/ai`; the composition roots wire it in. */
export interface ReplyModel {
  generate(request: ReplyGenerationRequest): Promise<ReplyGenerationResult>;
}

/** What the orchestration needs to know about the conversation before it generates anything. */
export interface DraftConversationSnapshot {
  readonly conversationId: string;
  readonly status: "OPEN" | "CLOSED";
  readonly aiEnabled: boolean;
  readonly takeoverState: "NONE" | "REVIEW_REQUIRED" | "HUMAN_ACTIVE";
  readonly mode: AiMode;
  /** Current conversation state, persisted with the draft so a later action can tell it has moved on. */
  readonly stateVersion: number;
  /**
   * True when a customer message newer than the anchor already exists. Comparing state versions here would
   * not work: the caller reads them at the same instant, so they are always equal.
   */
  readonly anchorSuperseded: boolean;
}

export interface PersistedDraft {
  readonly aiDraftId: string;
}

/** Persistence port. One narrow write, so the engine cannot touch anything else. */
export interface AiDraftStore {
  /**
   * Writes exactly one draft for a generation. `generationKey` makes a retried job idempotent: the same
   * key returns the existing draft instead of creating a second one.
   */
  saveDraft(input: SaveDraftInput): Promise<PersistedDraft>;
}

export interface SaveDraftInput {
  readonly scope: GenerationScope;
  readonly generationKey: string;
  readonly anchorMessageId: string;
  readonly anchorStateVersion: number;
  /** Null only for a held, unusable generation, which is stored for audit. */
  readonly text: string | null;
  readonly structuredOutput: unknown;
  readonly confidence: number;
  readonly modelSuggestsSend: boolean;
  readonly needsReview: boolean;
  readonly reasonCodes: readonly ReasonCode[];
  readonly intent?: string;
  readonly suggestedLeadStage?: string;
  readonly suggestedAction?: string;
  /** What the model said it relied on: a subset of what retrieval supplied, never more. */
  readonly factualSourceIds: readonly string[];
  /** What retrieval supplied and at what score, so a reviewer can tell a miss from an outage. */
  readonly retrieval: SuppliedRetrieval;
  readonly status: "PENDING" | "HELD";
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly requestId?: string;
  readonly latencyMs?: number;
  readonly usage?: ModelUsage;
}
