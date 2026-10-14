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
import type { AiMode, ReasonCode, StyleProfile } from "@omnichannel/domain";

import type { KnowledgeSegment, StyleSegment, SuppliedRetrieval } from "../retrieval/ports";

export type { KnowledgeSegment, StyleSegment };

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
  /**
   * The business's own voice, already resolved from Workspace base and Business Profile override. Trusted
   * configuration written by the business, never by a customer, and never a source of facts.
   *
   * Distinct from `style` below, which is retrieved *examples* of human writing: one says how to sound,
   * the other shows it. Neither can establish a fact.
   */
  readonly styleProfile: StyleProfile;
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
  /**
   * What asked for this generation: an inbound message, a person, or a scheduled follow-up (#55).
   *
   * Three values rather than a boolean, because afterwards a reader needs to tell a reply from a chase as
   * much as they need to tell automation from a person — and a draft that recorded a follow-up as
   * `AUTOMATIC` would make the audit trail unable to answer "why did we message them?".
   */
  readonly trigger: "AUTOMATIC" | "HUMAN_REQUEST" | "FOLLOW_UP";
  /** The workspace member who asked; present only for a human request. */
  readonly requestedByUserId?: string;
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
