# Factual & Style Retrieval Specification — v0.1

## Decision

Use two logically separate retrieval domains:

- `KnowledgeRetriever` for authoritative business facts;
- `StyleRetriever` for phrasing/tone examples.

A style example can never satisfy a factual-support requirement.

## Storage direction

Keep retrieval in PostgreSQL. Phase 2 uses PostgreSQL full-text search plus pgvector semantic retrieval behind `packages/db` / retrieval repositories. Prisma 7 does not need vector details in domain code; custom SQL/TypedSQL and migrations stay in infrastructure boundaries.

Embedding generation is hidden behind an `EmbeddingProvider` interface. Embeddings carry an explicit profile/version so model changes trigger controlled re-embedding rather than mixing incompatible vectors.

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

## Product-owner implementation clarifications — 2026-09-18

- Phase 2 must have an internal/dev/test seeding path for trusted Knowledge and approved Style so retrieval can be exercised end-to-end before Phase-5 customer UI exists.
- Workspace-base and Business-Profile-specific corpora are both eligible. True shadowing requires explicit override/supersession metadata; do not infer conflicts from semantic similarity. BP-specific results may receive deterministic scope priority for ordering, but ordering alone is not an authority override.
- Style examples should carry an optional normalized language/locale tag (BCP-47-compatible representation). `NULL` means language-agnostic/fallback; language-aware retrieval should prefer matching examples, then fall back safely.
- Semantic embeddings are a degradable capability. Missing/unavailable Voyage credentials must not prevent the worker or inbound pipeline from starting; run lexical-only, expose degraded health/diagnostics, and never reinterpret that degradation as factual certainty.
