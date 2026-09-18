/**
 * Factual and style retrieval boundaries (ADR-011, docs/specs/RETRIEVAL.md).
 *
 * The invariant this file exists to enforce: **style can influence wording but can never establish or
 * authorize a business fact.** That is structural here, not a rule someone has to remember:
 *
 * - two ports, two query types, two result types, with no shared supertype and no conversion between them.
 *   There is no value of type `StyleHit` that can be passed where a `KnowledgeHit` is expected;
 * - a `KnowledgeHit` carries document provenance (document, version, source type). A `StyleHit` carries none,
 *   because it is not evidence of anything;
 * - only knowledge chunk IDs are ever offered to the draft engine as citable sources.
 *
 * Embedding generation sits behind its own port: `packages/db` runs the SQL and never calls an AI provider,
 * and `packages/ai` produces vectors and never sees a query plan.
 */
/** Retrieval is always scoped to one tenant and one customer-data boundary. */
export interface RetrievalScope {
  readonly workspaceId: string;
  readonly businessProfileId: string;
}

/**
 * A vector together with the profile that produced it. Carrying the profile in the value (rather than
 * passing a bare `number[]` alongside a string someone has to remember to match) is what makes mixing two
 * embedding models' vectors a type-level mistake instead of a silent quality regression: retrieval filters
 * stored rows on exactly this profile, so vectors from different models are never compared.
 */
export interface EmbeddingVector {
  /** Opaque identity of model + dimensions + revision, e.g. `voyage-3.5:1024:v1`. Stored on every row. */
  readonly profile: string;
  readonly values: readonly number[];
}

/**
 * Asymmetric embedding models encode a question differently from the passage that answers it, so the
 * intent is part of the request rather than something the caller is trusted to configure.
 */
export type EmbeddingIntent = "QUERY" | "DOCUMENT";

/** Implemented in `packages/ai`; the composition roots wire it in. */
export interface EmbeddingProvider {
  readonly profile: string;
  readonly dimensions: number;
  embed(texts: readonly string[], intent: EmbeddingIntent): Promise<readonly EmbeddingVector[]>;
}

/**
 * The corpus could not be searched. Raised instead of returning an empty result, because "we found nothing"
 * and "we could not look" must never be confused: the first is a fact about the business, the second is a
 * fact about us, and only the first may be reported to a customer as knowledge.
 */
export class RetrievalUnavailableError extends Error {
  constructor(reason: string) {
    // Reasons name the class of failure; a driver message can quote stored customer content.
    super(`retrieval unavailable: ${reason}`);
    this.name = "RetrievalUnavailableError";
  }
}

export class EmbeddingUnavailableError extends Error {
  constructor(reason: string) {
    super(`embedding unavailable: ${reason}`);
    this.name = "EmbeddingUnavailableError";
  }
}

/** Where a hit sits in the scope hierarchy. Profile material is specific to one Business Profile. */
export type RetrievalScopeLevel = "WORKSPACE" | "BUSINESS_PROFILE";

export interface RetrievalQuery {
  readonly scope: RetrievalScope;
  /**
   * The customer's own words, used only as search terms. It is untrusted text, and the implementation must
   * treat it as a term list that cannot become query syntax.
   */
  readonly text: string;
  /** Absent means lexical-only retrieval, which is a supported configuration rather than a failure. */
  readonly embedding?: EmbeddingVector;
  readonly limit: number;
  readonly thresholds?: Partial<RetrievalThresholds>;
}

/**
 * Relevance floors are applied per list, on each list's own native score, before fusion — never on the
 * fused score. A reciprocal-rank score depends only on positions, so "0.03" means nothing about whether a
 * chunk is relevant; thresholding it would cut by list length instead of by relevance.
 */
export interface RetrievalThresholds {
  /** `ts_rank_cd` floor for the lexical list. */
  readonly minLexicalScore: number;
  /** Cosine-similarity floor (1 = identical) for the semantic list. */
  readonly minSimilarity: number;
}

/** A retrieved factual chunk. Only these may back a claim about the business. */
export interface KnowledgeHit {
  readonly chunkId: string;
  readonly documentId: string;
  readonly documentTitle: string;
  /** The document version this chunk belongs to; retrieval only ever returns the active version. */
  readonly documentVersion: number;
  readonly sourceType: string;
  readonly scopeLevel: RetrievalScopeLevel;
  readonly text: string;
  /** Fused score. Comparable within one result set, not across queries. */
  readonly score: number;
  /** 1-based position in each contributing list, for auditing why this was chosen. */
  readonly lexicalRank?: number;
  readonly semanticRank?: number;
}

/**
 * A human-written example used for tone. Deliberately carries no document, version or source type: there is
 * nothing here for a factual claim to cite, and the absence is the point.
 */
export interface StyleHit {
  readonly exampleId: string;
  readonly scopeLevel: RetrievalScopeLevel;
  readonly inboundContext: string;
  readonly outboundText: string;
  readonly provenance: "HUMAN_TYPED" | "HUMAN_EDITED_DRAFT";
  readonly score: number;
}

/** Counts that make a thin result explainable rather than mysterious. */
export interface RetrievalDiagnostics {
  readonly lexicalCandidates: number;
  readonly semanticCandidates: number;
  /**
   * Set when semantic retrieval contributed nothing, and why. `NO_EMBEDDING` is a deployment running
   * lexical-only; `PROVIDER_ERROR` is the embedding provider failing for this query; `PROFILE_MISMATCH` is
   * a corpus embedded under a different profile, which is the expected state during a re-embedding.
   */
  readonly semanticSkipped?: "NO_EMBEDDING" | "PROVIDER_ERROR" | "PROFILE_MISMATCH";
}

export interface KnowledgeRetrievalResult {
  readonly hits: readonly KnowledgeHit[];
  readonly diagnostics: RetrievalDiagnostics;
}

export interface StyleRetrievalResult {
  readonly hits: readonly StyleHit[];
  readonly diagnostics: RetrievalDiagnostics;
}

/** Implemented in `packages/db`. Authoritative business facts only. */
export interface KnowledgeRetriever {
  search(query: RetrievalQuery): Promise<KnowledgeRetrievalResult>;
}

/** Implemented in `packages/db`. Tone only; a hit here is never evidence. */
export interface StyleRetriever {
  search(query: RetrievalQuery): Promise<StyleRetrievalResult>;
}

/** Whether the factual corpus was actually consulted. Persisted with the draft and never inferred. */
export type KnowledgeRetrievalStatus = "OK" | "UNAVAILABLE";

/**
 * What retrieval supplied, with scores: the audit record stored on the draft.
 *
 * Deliberately separate from the draft's `factualSourceIds`, which records what the model said it *relied
 * on*. Keeping both is what lets a reviewer answer the two different questions — "was this fact available?"
 * and "did the model use it?" — and RETRIEVAL.md asks for exactly that pair.
 */
export interface SuppliedRetrieval {
  readonly status: KnowledgeRetrievalStatus;
  readonly knowledge: readonly {
    readonly chunkId: string;
    readonly documentId: string;
    readonly documentVersion: number;
    readonly scopeLevel: RetrievalScopeLevel;
    readonly score: number;
    readonly lexicalRank?: number;
    readonly semanticRank?: number;
  }[];
  readonly style: readonly { readonly exampleId: string; readonly score: number }[];
  readonly knowledgeDiagnostics: RetrievalDiagnostics;
  readonly styleDiagnostics?: RetrievalDiagnostics;
}

/** An empty record for a generation that did not consult retrieval at all. */
export function noRetrieval(status: KnowledgeRetrievalStatus = "OK"): SuppliedRetrieval {
  return { status, knowledge: [], style: [], knowledgeDiagnostics: { lexicalCandidates: 0, semanticCandidates: 0 } };
}
