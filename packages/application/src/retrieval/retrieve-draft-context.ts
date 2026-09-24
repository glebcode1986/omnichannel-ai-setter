/**
 * Assembling the retrieval half of a draft request (RETRIEVAL.md "Failure behavior").
 *
 * The whole file turns on one distinction: **"the business has no such fact" and "we could not look it up"
 * are different answers.** The first is knowledge about the business and may be reported to a customer as a
 * clarifying question; the second is a fact about our infrastructure and must never be presented as if the
 * business had been consulted. So failures are graded rather than collapsed:
 *
 * - the **factual corpus** failing is not recoverable here. The generation still runs (not every message
 *   needs a business fact) but is marked `UNAVAILABLE`, which forces the draft to human review;
 * - the **embedding provider** failing degrades semantic search to lexical-only. That is not an outage:
 *   lexical-only is a supported configuration — a deployment with no embedding key runs in it permanently —
 *   so an embedding blip lands in a mode we already accept as safe. It is recorded, not escalated;
 * - the **style corpus** failing is not an outage at all. A missing tone example cannot make a false
 *   statement; the reply simply sounds more generic.
 */
import type { ConversationSegment } from "../ai/ports";
import type {
  DraftRetrievalContext,
  EmbeddingProvider,
  EmbeddingVector,
  KnowledgeHit,
  KnowledgeRetrievalStatus,
  KnowledgeRetriever,
  RetrievalDiagnostics,
  RetrievalScope,
  StyleRetriever,
} from "./ports";

export interface RetrievalLogPort {
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface DraftRetrievalDependencies {
  readonly knowledge: KnowledgeRetriever;
  readonly style: StyleRetriever;
  /** Absent means lexical-only retrieval: a deliberate configuration, not a degraded state. */
  readonly embeddings?: EmbeddingProvider;
  readonly log: RetrievalLogPort;
  readonly knowledgeLimit?: number;
  readonly styleLimit?: number;
}

export interface DraftRetrievalQuery {
  readonly scope: RetrievalScope;
  /** The customer messages this reply answers. Their text is used only as search terms. */
  readonly inbound: readonly ConversationSegment[];
  /**
   * The language the reply will be written in, from the resolved StyleProfile — the business's own
   * configuration, never inferred from the customer's words. Canonical BCP-47 by then: the profile is
   * where it is normalized.
   *
   * It reaches **style** retrieval only. An example written in one language teaches the wrong rhythm for
   * a reply in another, but a fact is a fact whatever language it was written in, so knowledge retrieval
   * is deliberately not given it.
   */
  readonly language?: string;
}

const DEFAULT_KNOWLEDGE_LIMIT = 8;
/** Deliberately small: RETRIEVAL.md asks for few style examples so the model imitates rather than parrots. */
const DEFAULT_STYLE_LIMIT = 3;
/**
 * Search terms are capped from the end of the burst. The newest words are the question being answered; an
 * opening "hi, hope you're well" contributes nothing but noise to a term query.
 */
const MAX_QUERY_CHARS = 1_000;

export async function retrieveDraftContext(
  dependencies: DraftRetrievalDependencies,
  query: DraftRetrievalQuery,
): Promise<DraftRetrievalContext> {
  const fields = { workspaceId: query.scope.workspaceId, businessProfileId: query.scope.businessProfileId };
  const text = searchTerms(query.inbound);
  const { embedding, failed: embeddingFailed } = await embedQuery(dependencies, text, fields);

  if (text === "" && embedding === undefined) {
    // Nothing to search with: an empty burst (media only) is not a factual question. No `semanticSkipped`
    // reason is recorded, because nothing was skipped — there was no query to run on either side.
    return empty("OK", { lexicalCandidates: 0, semanticCandidates: 0 });
  }

  const base = {
    scope: query.scope,
    text,
    ...(embedding === undefined ? {} : { embedding }),
  };

  // The retriever only knows that no vector arrived; only this layer knows the provider is the reason.
  const withFailure = (diagnostics: RetrievalDiagnostics): RetrievalDiagnostics =>
    embeddingFailed ? { ...diagnostics, semanticSkipped: "PROVIDER_ERROR" } : diagnostics;

  // Concurrently: the two corpora are independent, and this sits inside the channel's total response
  // budget alongside debounce, generation and the delivery delay. `allSettled` rather than `all` because
  // the two failures are graded differently and one must not cancel the other.
  const [factual, tone] = await Promise.allSettled([
    dependencies.knowledge.search({ ...base, limit: dependencies.knowledgeLimit ?? DEFAULT_KNOWLEDGE_LIMIT }),
    dependencies.style.search({
      ...base,
      limit: dependencies.styleLimit ?? DEFAULT_STYLE_LIMIT,
      ...(query.language === undefined ? {} : { language: query.language }),
    }),
  ]);

  let knowledgeHits: readonly KnowledgeHit[] = [];
  let knowledgeDiagnostics: RetrievalDiagnostics = { lexicalCandidates: 0, semanticCandidates: 0 };
  let status: KnowledgeRetrievalStatus = "OK";
  if (factual.status === "fulfilled") {
    knowledgeHits = factual.value.hits;
    knowledgeDiagnostics = factual.value.diagnostics;
  } else {
    // Not rethrown: a message that needs no business fact can still be answered, and the draft carries the
    // outage into review rather than the customer receiving confident-sounding silence about it.
    dependencies.log.warn("ai.knowledge_retrieval_failed", { ...fields, errorName: errorName(factual.reason) });
    status = "UNAVAILABLE";
  }

  let styleHits: readonly { exampleId: string; outboundText: string; score: number }[] = [];
  let styleDiagnostics: RetrievalDiagnostics | undefined;
  if (tone.status === "fulfilled") {
    styleHits = tone.value.hits.map((hit) => ({ exampleId: hit.exampleId, outboundText: hit.outboundText, score: hit.score }));
    styleDiagnostics = tone.value.diagnostics;
  } else {
    // Tone is optional. Losing it cannot produce a false statement, so it never blocks or flags a draft.
    dependencies.log.warn("ai.style_retrieval_failed", { ...fields, errorName: errorName(tone.reason) });
  }

  // Defence in depth for the one invariant this module exists to protect: the draft engine decides which
  // claimed sources are real by membership in the knowledge set, so a style example sharing an ID with a
  // chunk would let tone authorize a fact. It cannot happen with distinct ID spaces — which is why it is
  // worth failing loudly if it ever does.
  const chunkIds = new Set(knowledgeHits.map((hit) => hit.chunkId));
  const style = styleHits.filter((hit) => {
    if (!chunkIds.has(hit.exampleId)) {
      return true;
    }
    dependencies.log.warn("ai.retrieval_id_collision", { ...fields, id: hit.exampleId });
    return false;
  });

  return {
    knowledge: knowledgeHits.map((hit) => ({ chunkId: hit.chunkId, text: hit.text })),
    style: style.map((hit) => ({ exampleId: hit.exampleId, text: hit.outboundText })),
    supplied: {
      status,
      knowledge: knowledgeHits.map((hit) => ({
        chunkId: hit.chunkId,
        documentId: hit.documentId,
        documentVersion: hit.documentVersion,
        scopeLevel: hit.scopeLevel,
        score: hit.score,
        ...(hit.lexicalRank === undefined ? {} : { lexicalRank: hit.lexicalRank }),
        ...(hit.semanticRank === undefined ? {} : { semanticRank: hit.semanticRank }),
      })),
      style: style.map((hit) => ({ exampleId: hit.exampleId, score: hit.score })),
      knowledgeDiagnostics: withFailure(knowledgeDiagnostics),
      ...(styleDiagnostics === undefined ? {} : { styleDiagnostics: withFailure(styleDiagnostics) }),
    },
  };
}

async function embedQuery(
  dependencies: DraftRetrievalDependencies,
  text: string,
  fields: Readonly<Record<string, unknown>>,
): Promise<{ readonly embedding?: EmbeddingVector; readonly failed: boolean }> {
  if (dependencies.embeddings === undefined || text === "") {
    return { failed: false };
  }
  try {
    const vectors = await dependencies.embeddings.embed([text], "QUERY");
    const embedding = vectors[0];
    // A provider that returns nothing has failed, however politely: treat it as such rather than as a
    // deliberate lexical-only run, so the draft's audit record says what actually happened.
    return embedding === undefined ? { failed: true } : { embedding, failed: false };
  } catch (error) {
    dependencies.log.warn("ai.embedding_unavailable", { ...fields, errorName: errorName(error) });
    return { failed: true };
  }
}

/**
 * The burst's text, newest words last, capped from the end. Returned as plain terms: the implementation
 * behind the port must parse it as a term list, never as query syntax.
 */
function searchTerms(inbound: readonly ConversationSegment[]): string {
  const joined = inbound
    .map((segment) => segment.text.trim())
    .filter((text) => text !== "")
    .join("\n");
  return joined.length <= MAX_QUERY_CHARS ? joined : joined.slice(joined.length - MAX_QUERY_CHARS);
}

function empty(status: KnowledgeRetrievalStatus, diagnostics: RetrievalDiagnostics): DraftRetrievalContext {
  return { knowledge: [], style: [], supplied: { status, knowledge: [], style: [], knowledgeDiagnostics: diagnostics } };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
