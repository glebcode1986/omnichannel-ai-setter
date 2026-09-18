/**
 * The PostgreSQL behind factual and style retrieval (ADR-011, docs/specs/RETRIEVAL.md).
 *
 * The SQL lives in exported builders rather than inline in the retrievers so that the queries can be
 * `EXPLAIN`ed in tests. A query shape that quietly stops using its index is invisible in every other kind
 * of test: the results are identical, only slower, until the corpus is large enough to matter.
 *
 * Three query-shape decisions carry most of the weight:
 *
 * 1. **The customer's words become an OR query, not an AND query.** Every `*_to_tsquery` function combines
 *    terms with AND, which for a whole customer message means "return a chunk only if it contains every
 *    word the customer wrote" — a message of any length then matches nothing at all. So the terms are
 *    lexemes extracted from the text and re-joined with `|`, and `ts_rank_cd` decides how much of the
 *    query a chunk actually covered.
 * 2. **The terms are never parsed as query syntax.** They come out of `to_tsvector`, which accepts any text
 *    and cannot fail on it, and each lexeme is re-quoted with `quote_literal` before it re-enters a
 *    `tsquery`. `to_tsquery` on raw customer text would instead raise a syntax error on a stray quote or
 *    `&` — turning an ordinary message into a retrieval outage.
 * 3. **Vector search is exact, and there is deliberately no ANN index.** See `SEMANTIC_ORDER` below.
 */

/** Fixed by the `vector(1024)` column: a profile with other dimensions needs a migration (ADR-011). */
export const EMBEDDING_DIMENSIONS = 1_024;

/**
 * `ts_rank_cd` floor, on the normalized 0-1 scale (`ts_rank_cd(..., 32)` is `rank/(rank+1)`). Normalizing
 * is what makes a fixed floor meaningful at all: a raw `ts_rank_cd` grows without bound, so the same
 * threshold would mean different things for a long document and a short one.
 *
 * Low on purpose. With OR semantics and the `simple` configuration — which removes no stopwords — a chunk
 * can match on a single common word, so the floor only has to exclude the very weakest matches; ranking,
 * the candidate cap and fusion do the rest.
 */
export const DEFAULT_MIN_LEXICAL_SCORE = 0.05;
/**
 * Cosine-similarity floor. Tuned for normalized modern embedding models, where unrelated text lands near
 * 0.3-0.5 and genuinely related text sits well above. It is a query parameter, not a constant, because the
 * right value is a property of the embedding profile.
 */
export const DEFAULT_MIN_SIMILARITY = 0.55;

/**
 * Candidates fetched per list before fusion. Fusion can only reorder what it is given, so each list needs
 * more than the final result size or the two lists cannot disagree usefully.
 */
export const CANDIDATE_MULTIPLIER = 4;
export const MIN_CANDIDATES = 20;
/** A ceiling on the work one query can ask for, whatever limit a future caller passes. */
export const MAX_CANDIDATES = 200;

export function candidateLimit(limit: number): number {
  const requested = Number.isFinite(limit) ? Math.trunc(limit) * CANDIDATE_MULTIPLIER : 0;
  return Math.min(MAX_CANDIDATES, Math.max(MIN_CANDIDATES, requested));
}

/**
 * Why semantic search is exact, and why there is no HNSW index.
 *
 * Whether a chunk may be retrieved at all depends on its *document*: the Business Profile scope, the
 * document status and the current version all live on `knowledge_documents`. A correct query therefore has
 * to join, and an ANN index cannot serve an ordering that sits above a join — the planner confirms it,
 * which is what the query-plan test checks.
 *
 * Forcing the index anyway would be worse than slow, it would be wrong: an HNSW scan returns the globally
 * nearest vectors and the join then discards the ones belonging to other tenants or to superseded
 * versions. A small Business Profile's facts can be crowded out of the candidate list entirely by a large
 * one's, and the query returns nothing while the fact sits in the table. Retrieval would fail silently,
 * and it would fail worst for exactly the tenants with the least data.
 *
 * Exact search is O(corpus) per query, which is the right trade for a per-profile knowledge base of
 * hundreds to a few thousand chunks, and it is strictly more accurate than an approximate index. The
 * upgrade path is deliberate rather than urgent: denormalize the scope, status and current-version facts
 * onto `knowledge_chunks` so the filter becomes chunk-local, then add HNSW with pgvector's iterative scan.
 * That is a schema change with a maintenance obligation, and it belongs to the task that builds knowledge
 * ingestion, not to this one.
 */
const SEMANTIC_ORDER = `ORDER BY "score" DESC`;

/**
 * Active, current-version chunks of one workspace, visible to one Business Profile.
 *
 * The version predicate is what makes a superseded fact unreachable: editing a document creates a new
 * version and leaves the old chunks in place for audit, so filtering on `status` alone would keep serving
 * last month's prices from rows that are still, technically, ACTIVE.
 */
const knowledgeFrom = (extraJoin = ""): string => `
  FROM "knowledge_chunks" c
  JOIN "knowledge_documents" d
    ON d."workspace_id" = c."workspace_id" AND d."id" = c."document_id"${extraJoin}
  WHERE c."workspace_id" = $1
    AND (d."business_profile_id" IS NULL OR d."business_profile_id" = $2)
    AND d."status" = 'ACTIVE'
    AND c."document_version" = d."version"`;

const KNOWLEDGE_COLUMNS = `
    c."id" AS "chunk_id",
    c."document_id",
    c."document_version",
    c."content",
    d."title" AS "document_title",
    d."source_type"::text AS "source_type",
    (d."business_profile_id" IS NOT NULL) AS "profile_scoped"`;

/**
 * The customer's text as an OR `tsquery`.
 *
 * `to_tsvector` normalizes arbitrary text into lexemes and cannot fail on it; `quote_literal` puts each
 * lexeme back in the quoted form a `tsquery` expects, so a word containing a quote or an `&` survives
 * intact instead of becoming syntax. Text with no lexemes at all yields NULL, and `@@ NULL` matches
 * nothing — the safe direction.
 */
const TS_QUERY = `(SELECT string_agg(quote_literal("lexeme"), ' | ') FROM unnest(to_tsvector('simple', $3)))::tsquery`;

/**
 * The indexed expression, shared by the queries and by the migration's GIN indexes.
 *
 * It has to stay character-identical on both sides or PostgreSQL silently stops using the index: same
 * results, full scan, and no test would notice until the corpus was large. Exported so the match can be
 * asserted rather than assumed.
 */
export const searchableExpression = (column: string): string => `to_tsvector('simple', ${column})`;

/** Normalization 32 maps the rank onto 0-1 (`rank/(rank+1)`), so the floor means the same everywhere. */
const rank = (column: string): string => `ts_rank_cd(${searchableExpression(column)}, q."query", 32)`;

/** $1 workspace, $2 business profile, $3 search terms, $4 minimum rank, $5 limit. */
export function knowledgeLexicalSql(): string {
  return `
  WITH q AS (SELECT ${TS_QUERY} AS "query")
  SELECT ${KNOWLEDGE_COLUMNS},
    ${rank('c."content"')} AS "score"
  ${knowledgeFrom('\n  CROSS JOIN q')}
    AND ${searchableExpression('c."content"')} @@ q."query"
    AND ${rank('c."content"')} >= $4
  ORDER BY "score" DESC, c."id" ASC
  LIMIT $5`;
}

/** $1 workspace, $2 business profile, $3 vector literal, $4 embedding profile, $5 max distance, $6 limit. */
export function knowledgeSemanticSql(): string {
  return `
  SELECT ${KNOWLEDGE_COLUMNS},
    1 - (c."embedding" <=> $3::vector) AS "score"
  ${knowledgeFrom()}
    AND c."embedding_profile" = $4
    AND c."embedding" <=> $3::vector <= $5
  ${SEMANTIC_ORDER}, c."id" ASC
  LIMIT $6`;
}

const styleFrom = (extraJoin = ""): string => `
  FROM "style_examples" s${extraJoin}
  WHERE s."workspace_id" = $1
    AND (s."business_profile_id" IS NULL OR s."business_profile_id" = $2)
    AND s."status" = 'ACTIVE'`;

const STYLE_COLUMNS = `
    s."id" AS "example_id",
    s."inbound_context",
    s."outbound_text",
    s."provenance"::text AS "provenance",
    (s."business_profile_id" IS NOT NULL) AS "profile_scoped"`;

/**
 * Style examples are matched on the *inbound context* they were written in answer to, not on the outbound
 * text: the question is "how did a human answer a message like this one", and matching the reply text would
 * retrieve examples that merely sound like the customer.
 */
export function styleLexicalSql(): string {
  return `
  WITH q AS (SELECT ${TS_QUERY} AS "query")
  SELECT ${STYLE_COLUMNS},
    ${rank('s."inbound_context"')} AS "score"
  ${styleFrom('\n  CROSS JOIN q')}
    AND ${searchableExpression('s."inbound_context"')} @@ q."query"
    AND ${rank('s."inbound_context"')} >= $4
  ORDER BY "score" DESC, s."id" ASC
  LIMIT $5`;
}

/**
 * Whether anything in scope is embedded under a given profile.
 *
 * Asked only when semantic search returned nothing, to tell two very different situations apart: "nothing
 * was similar enough" (normal, and lexical search still had its say) and "no row in this corpus carries
 * this embedding profile at all" — an un-embedded corpus, or one mid-way through a re-embedding, where
 * semantic search structurally could not contribute. Reporting the first as the second would be a lie in
 * an audit record, and the second is the one an operator needs to see.
 *
 * $1 workspace, $2 business profile, $3 embedding profile.
 */
export function knowledgeProfileProbeSql(): string {
  return `
  SELECT EXISTS (
    SELECT 1
    ${knowledgeFrom()}
      AND c."embedding_profile" = $3
  ) AS "present"`;
}

export function styleProfileProbeSql(): string {
  return `
  SELECT EXISTS (
    SELECT 1
    ${styleFrom()}
      AND s."embedding_profile" = $3
  ) AS "present"`;
}

export function styleSemanticSql(): string {
  return `
  SELECT ${STYLE_COLUMNS},
    1 - (s."embedding" <=> $3::vector) AS "score"
  ${styleFrom()}
    AND s."embedding_profile" = $4
    AND s."embedding" <=> $3::vector <= $5
  ${SEMANTIC_ORDER}, s."id" ASC
  LIMIT $6`;
}

/** pgvector's text input format. Rejecting non-finite values here keeps a NaN out of the SQL literal. */
export function toVectorLiteral(values: readonly number[]): string {
  if (values.length !== EMBEDDING_DIMENSIONS) {
    throw new RangeError(`expected ${String(EMBEDDING_DIMENSIONS)} dimensions, received ${String(values.length)}`);
  }
  for (const value of values) {
    if (!Number.isFinite(value)) {
      throw new RangeError("embedding contains a non-finite value");
    }
  }
  return `[${values.join(",")}]`;
}
