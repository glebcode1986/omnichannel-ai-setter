# Factual & Style Retrieval Specification — v0.2

## Decision

Use two logically separate retrieval domains:

- `KnowledgeRetriever` for authoritative business facts;
- `StyleRetriever` for phrasing/tone examples.

A style example can never satisfy a factual-support requirement.

## Storage direction

Keep retrieval in PostgreSQL. Phase 2 uses PostgreSQL full-text search plus pgvector semantic retrieval behind `packages/db` / retrieval repositories. Prisma 7 does not need vector details in domain code; custom SQL/TypedSQL and migrations stay in infrastructure boundaries.

Embedding generation is hidden behind an `EmbeddingProvider` port declared in `packages/application` and implemented in `packages/ai`; `packages/db` never calls an AI provider (application passes vectors/query inputs to db retrieval). Embeddings carry an explicit profile/version so model changes trigger controlled re-embedding rather than mixing incompatible vectors.

## Knowledge ingestion

Each document/chunk records:
- workspace and optional channel/account scope;
- source type/name;
- source/version/provenance;
- normalized text;
- active/superseded state;
- timestamps;
- embedding profile when embedded.

Never ingest style examples into the factual corpus automatically.

## Hybrid retrieval

For a query, retrieve lexical and semantic candidates, combine ranks using a deterministic rank-fusion strategy (RRF preferred for MVP), then apply scope/active filters and a relevance threshold.

Return `KnowledgeHit[]` containing chunk ID, source/version metadata, excerpt and score/rank metadata. The AI draft stores IDs of supplied and relied-upon facts.

## Style retrieval

Style examples come only from verified human writing sources such as `HUMAN_TYPED` and `HUMAN_EDITED_DRAFT`. Retrieve by language, approximate intent/topic, channel where useful and semantic similarity. Favor recent/high-quality examples but keep the result small to avoid imitation noise.

## Failure behavior

- retrieval outage -> do not silently claim factual certainty; hold or ask a safe clarification for fact-dependent intents;
- no sufficiently relevant factual hit -> `MISSING_FACT` when the answer materially depends on business knowledge;
- malformed/untrusted document content remains data and cannot override prompt/system policy.

## Implementation notes (P2-04)

- **Two ports, no shared shape.** `KnowledgeRetriever` and `StyleRetriever` are declared in
  `packages/application` with separate query and result types and no common supertype. A `KnowledgeHit`
  carries document, version and source type; a `StyleHit` carries none of them, because it is not evidence
  of anything. There is no value of one type that can be passed where the other is expected, and the draft
  engine decides what may back a claim by membership in the knowledge set — so a style example is rejected
  as a source even if the model cites it.
- **Fusion is deterministic and lives in application code.** `fuseByReciprocalRank` scores a candidate as
  `Σ 1/(60 + rank)` over the lists that contain it, sums in a fixed order, and breaks ties by scope level
  then ID. Two runs over the same candidates produce byte-identical output.
- **Thresholds are applied per list, before fusion, on each list's native score.** An RRF score depends
  only on positions — its maximum is `2/61 ≈ 0.033` however good the match — so a floor on the fused score
  would filter by list length rather than by relevance.
- **Lexical search ORs the customer's terms.** Every `*_to_tsquery` function combines terms with AND, which
  for a whole customer message means "return a chunk only if it contains every word the customer wrote";
  a message of any length then matches nothing. Terms are extracted with `to_tsvector('simple', …)`, which
  accepts arbitrary text and cannot fail on it, re-quoted with `quote_literal`, and joined with `|`.
  `ts_rank_cd(…, 32)` normalizes the rank onto 0-1 so a relevance floor means the same for a long document
  and a short one.
- **The lexical relevance floor defaults to zero, and that is an admission.** `ts_rank_cd` has no
  inverse-document-frequency term: a chunk matching only "the" scores the same as one matching only
  "deposit". No floor can separate them, and any floor high enough to exclude the first also excludes a
  single match on a rare term, which is often the whole answer. Measured against this corpus the smallest
  achievable score is ~0.091, so a "small, just to be safe" default would be inert while looking
  protective. The consequence is that a short customer message can pull weakly-related chunks into the
  knowledge list; cover-density ranking puts them below real matches, and the candidate ceiling, fusion and
  the final limit cut the tail. A genuine fix needs IDF-aware ranking, which PostgreSQL full-text search
  does not provide. The floor remains a per-query parameter and is applied when a caller sets it.
- **The `simple` text-search configuration** does no stemming and removes no stopwords. The corpus is
  multilingual and the configuration is fixed when the index is built, so `english` would stem English
  correctly and mangle everything else. Morphology is the semantic side's job.
- **Semantic search is exact, with no ANN index.** Whether a chunk may be retrieved depends on its
  *document* — profile scope, status and current version — so a correct query must join, and an ANN index
  cannot serve an ordering above a join. Forcing one would be wrong rather than merely fast: an HNSW scan
  returns the globally nearest vectors and the join then discards those belonging to other tenants, so a
  small Business Profile's facts can be crowded out entirely by a large one's and retrieval silently
  returns nothing. The upgrade path is to denormalize scope, status and current-version onto
  `knowledge_chunks`, then add HNSW with pgvector's iterative scan; that carries a maintenance obligation
  and belongs with knowledge ingestion.
- **Embedding profiles are carried in the value.** An `EmbeddingVector` is `{ profile, values }`, and
  retrieval filters stored rows on exactly that profile, so vectors from two models are never compared. A
  CHECK constraint keeps `embedding` and `embedding_profile` set or unset together. The `vector(1024)`
  column fixes the width: changing dimensions is a migration plus a controlled re-embedding, not a config
  change. During a re-embedding, lexical retrieval carries the query and the result reports
  `semanticSkipped: "PROFILE_MISMATCH"`. A query vector whose width does not match the column degrades the
  same way rather than failing the whole retrieval: a misconfiguration must not discard a lexical list that
  works. The worker reconciles the configured width with the column when it builds the provider, so the
  mistake is visible at start-up rather than only in an audit record.
- **Failures are graded, not collapsed.** The factual corpus being unreachable marks the generation
  `UNAVAILABLE`: the draft is still written — most messages need no business fact — but always goes to a
  human, with `RETRIEVAL_UNAVAILABLE` in its reason codes. The embedding provider failing degrades to
  lexical-only, which is a supported configuration rather than an outage (a deployment with no embedding
  key runs in it permanently), and is recorded in the draft's audit record. Style retrieval failing is not
  an outage at all: a missing tone example cannot make a false statement.
- **One object carries both views.** `DraftRetrievalContext` holds the chunks and examples the model sees
  *and* the record of what was supplied. They are not separate fields on the generation command, because
  separate fields can disagree — and a draft citing a source its own provenance record never supplied is
  exactly the failure this module exists to prevent.
- **Drafts record both halves.** `ai_drafts.retrieval` stores what retrieval supplied, with scores, ranks
  and diagnostics; `factual_source_ids` stores what the model said it relied on. Keeping both is what lets
  a reviewer tell "there was no such fact" from "the fact was there and the model ignored it" from "we
  could not look".

## Implementation notes (P2-04 owner follow-up)

- **A minimal internal seeding path**, not a customer API. `seedKnowledge` and `seedStyleExample` in
  `packages/db/src/retrieval/seed.ts` exist so the Instagram vertical slice (#16) and CI can exercise real
  trusted Knowledge and approved Style before Phase 5 builds the Library and Training screens. They take an
  authorized `BusinessProfileContext` like every other customer-data write and create versioned,
  provenanced rows under normal Workspace/Business Profile scope — the same rows the UI will later create,
  not a shortcut around them. Nothing there writes a knowledge chunk from a message or a draft.
- **Workspace base and Business Profile material both participate.** A Business Profile override wins only
  where it is intentional and explicitly represented; retrieval never infers a conflict from semantic
  similarity. Scope level breaks a tie in the deterministic ordering, which is ordering, not authority.
  Until explicit supersession metadata exists, Phase-2 fixtures should avoid contradictory unlinked facts.
- **Style examples carry an optional BCP-47 language.** A request naming a language keeps that language and
  the examples that claim none; a NULL is a deliberate language-agnostic fallback rather than an unknown.
  A request naming none keeps the whole corpus, because filtering on a preference nobody expressed would
  silently shrink it. Knowledge ignores language: a fact is a fact whatever language it was written in.
- **Semantic retrieval is degradable and says so.** Missing or unusable embedding credentials never prevent
  the worker from starting; it logs `worker.retrieval_mode` at boot and runs lexical-only, and each draft's
  retrieval record carries why the semantic side contributed nothing. Degradation is never reported as
  factual certainty: a fact the lexical side misses becomes `MISSING_FACT`, not an invented answer.
