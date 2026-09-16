# Task Contract — P2-04 Claude

**Issue:** #11 `[P2-04] Implement separate factual and style retrieval`  
**Branch:** `feat/p2-04-retrieval`  
**Depends on:** DB foundation #4 and AI request/draft contract #10.  
**Owner:** Claude. Do not merge own PR.

## Read first
`PROJECT_CONTEXT.md`, `RETRIEVAL.md`, ADR-011, `DATA_MODEL.md`, `AI_ORCHESTRATION.md`, Issue #11.

## Objective
Implement separate `KnowledgeRetriever`, `StyleRetriever` and `EmbeddingProvider` boundaries using PostgreSQL lexical retrieval plus pgvector semantic retrieval with deterministic rank fusion.

## Core invariant
Style can influence wording but can never establish or authorize a business fact. Factual knowledge and style examples remain separate in storage, retrieval APIs, provenance and prompt assembly.

## Required behavior
- workspace/account scope on every retrieval query;
- active/versioned knowledge provenance;
- embedding profile/model/version recorded;
- deterministic RRF-style lexical+semantic fusion and explicit relevance threshold;
- source IDs/scores persisted with drafts;
- stale/superseded facts excluded;
- no-hit factual query can produce `MISSING_FACT` rather than hallucinated support;
- retrieval outage fails safely and observably.

## Tests
Cross-workspace isolation, lexical-only hit, semantic-only hit, fused ordering determinism, stale/superseded fact, no hit, style-only source not satisfying factual support, retrieval outage, embedding-profile mismatch.

## PR requirements
Document pgvector/index/query choices and deterministic fusion formula. Run migration/integration/root checks. Do not merge.
