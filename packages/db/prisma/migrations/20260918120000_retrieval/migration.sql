-- Factual and style retrieval (ADR-011, docs/specs/RETRIEVAL.md).
--
-- Index and query choices, and why:
--
--   * Lexical search uses an EXPRESSION index on `to_tsvector('simple', ...)` rather than a stored tsvector
--     column. The expression is repeated verbatim in the queries so the planner can use the index, and no
--     column is added that Prisma would have to model but cannot (a GENERATED column has no Prisma
--     representation, and a trigger-maintained one can silently rot).
--   * The 'simple' text-search configuration does no stemming and no stopword removal. That is deliberate:
--     the corpus is multilingual and the configuration is fixed at index-build time, so picking 'english'
--     would stem English correctly and mangle everything else. Morphology is what the semantic side is for.
--   * Semantic search is EXACT, with no ANN index. Whether a chunk may be retrieved depends on its
--     document (profile scope, status, current version), so a correct query must join, and an ANN index
--     cannot serve an ordering above a join. Forcing one would return the globally nearest vectors and let
--     the join discard those belonging to other tenants -- a small profile's facts crowded out by a large
--     profile's, retrieval silently returning nothing. See `src/retrieval/sql.ts` for the upgrade path.
--   * `vector(1024)` fixes the dimension in the column. Two embedding profiles with different dimensions
--     therefore cannot share the column: changing dimensions is a migration plus a controlled re-embedding,
--     which is exactly the "controlled re-embedding" ADR-011 asks for instead of silently mixing vectors.

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "knowledge_chunks" ADD COLUMN "embedding" vector(1024);
ALTER TABLE "style_examples" ADD COLUMN "embedding" vector(1024);

-- What retrieval supplied, with scores. Separate from `factual_source_ids` (what the model relied on).
ALTER TABLE "ai_drafts" ADD COLUMN "retrieval" jsonb;

-- A vector without its profile could be compared against a different model's vectors; a profile without a
-- vector claims an embedding that does not exist. Neither half is meaningful alone.
ALTER TABLE "knowledge_chunks"
  ADD CONSTRAINT "knowledge_chunks_embedding_profile_check"
  CHECK (("embedding" IS NULL) = ("embedding_profile" IS NULL));
ALTER TABLE "style_examples"
  ADD CONSTRAINT "style_examples_embedding_profile_check"
  CHECK (("embedding" IS NULL) = ("embedding_profile" IS NULL));

CREATE INDEX "knowledge_chunks_search_idx" ON "knowledge_chunks" USING GIN (to_tsvector('simple', "content"));
CREATE INDEX "style_examples_search_idx" ON "style_examples" USING GIN (to_tsvector('simple', "inbound_context"));

-- Every retrieval query filters by workspace first; the scope columns lead so the tenant filter is an index
-- lookup rather than a filter applied after a full scan.
CREATE INDEX "knowledge_chunks_scope_idx" ON "knowledge_chunks" ("workspace_id", "document_id", "document_version");
