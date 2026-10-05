-- Whether a knowledge document is actually searchable (KNOWLEDGE_STYLE_UX.md, RETRIEVAL.md, Issue #31).
--
-- The contract's invariant is that failed ingestion cannot look active, and until now there was nowhere to
-- record that ingestion had failed at all. A document whose chunking or embedding did not complete was
-- indistinguishable from one that simply had no embeddings yet, and both looked exactly like a healthy
-- ACTIVE source in every list — which is the worst of the three, because an operator then believes the
-- business has told the assistant something it has not.
--
-- `PENDING` is the honest default for every existing row: they were written by the internal seeding path,
-- which does not report an outcome, so claiming they are INDEXED would be inventing a fact about them.
-- Retrieval is unaffected either way — it reads chunks, and a chunk with no embedding is simply not
-- semantically reachable.

CREATE TYPE "KnowledgeIndexingState" AS ENUM ('PENDING', 'INDEXED', 'FAILED');

ALTER TABLE "knowledge_documents"
  ADD COLUMN "indexing_state" "KnowledgeIndexingState" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "indexing_error" TEXT,
  ADD COLUMN "indexed_at" TIMESTAMP(3);

-- The invariant, enforced where it cannot be forgotten: a document whose ingestion failed may not be
-- ACTIVE. Archiving it, or fixing and re-indexing it, are the two ways forward — and both are deliberate.
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_failed_not_active_check" CHECK (
  NOT ("status" = 'ACTIVE' AND "indexing_state" = 'FAILED')
);

-- An error message belongs to a failure and nowhere else. A stale message left on a document that has
-- since indexed successfully would be read as a current problem.
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_indexing_error_check" CHECK (
  ("indexing_state" = 'FAILED') = ("indexing_error" IS NOT NULL)
);

-- Likewise the timestamp: it records when this document last became searchable.
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_indexed_at_check" CHECK (
  "indexing_state" <> 'INDEXED' OR "indexed_at" IS NOT NULL
);

-- Listing a Business Profile's library is filtered by status and ordered by recency.
CREATE INDEX "knowledge_documents_library_idx"
  ON "knowledge_documents" ("workspace_id", "business_profile_id", "status", "updated_at" DESC);
