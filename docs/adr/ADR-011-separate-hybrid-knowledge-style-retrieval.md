# ADR-011: Separate knowledge/style retrieval with PostgreSQL hybrid search

**Status:** Accepted

## Decision

Store authoritative factual knowledge and style examples as separate retrieval domains. Use PostgreSQL lexical search plus pgvector semantic search behind infrastructure repositories; combine candidates deterministically (RRF preferred for MVP).

## Why

One database reduces operational complexity, hybrid retrieval improves robustness, and strict separation prevents human tone examples from becoming accidental factual authority.

## Consequences

- Prisma 7 vector-specific SQL stays in `packages/db` via migration/raw SQL/TypedSQL as appropriate;
- embeddings carry a profile/version;
- changing embedding models requires controlled re-embedding;
- factual provenance IDs are persisted with AI drafts.
