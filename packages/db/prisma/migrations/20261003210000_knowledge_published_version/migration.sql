-- Which version of a knowledge source customers can actually be told about.
--
-- Retrieval used to follow `version`, the latest saved one. So pressing Save on a live source published
-- the new wording at once, while the editor promised the opposite: "Never a live change... publishing is
-- a separate, deliberate act". An operator correcting a price had no way to stage the correction, and no
-- way to know the old one had already stopped being the answer.
--
-- The published version is now its own column. Save moves `version`; only an explicit publish moves
-- `published_version`, and retrieval joins the chunks of that one. Editing a live source therefore keeps
-- answering with the wording somebody approved, until somebody approves the next.
ALTER TABLE "knowledge_documents" ADD COLUMN "published_version" INTEGER;

-- Everything live today was live on its current version, which is what retrieval was serving.
UPDATE "knowledge_documents" SET "published_version" = "version" WHERE "status" = 'ACTIVE';

-- A published version is a version this document has had. The upper bound is the point: it cannot name
-- content that does not exist yet, which is how a stale write would try to publish a future edit.
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_published_version_check" CHECK (
  "published_version" IS NULL OR ("published_version" >= 1 AND "published_version" <= "version")
);

-- ACTIVE means "answering customers", and a document with nothing published answers nothing. Without
-- this, an ACTIVE row with a NULL published version would be silently invisible to retrieval — a source
-- the library shows as in use and the assistant never sees, which is the exact confusion the indexing
-- badge exists to prevent.
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_active_published_check" CHECK (
  "status" <> 'ACTIVE' OR "published_version" IS NOT NULL
);
