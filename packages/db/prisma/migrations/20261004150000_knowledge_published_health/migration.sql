-- "A failed source cannot look active" was written when a document had one version, and it stopped being
-- true the moment publishing became separate from saving.
--
-- The indexing state describes the *current* version — every edit resets it to PENDING. So after
-- publish/index v1 and Save v2, a failure to index v2 was a failure of content no customer has ever been
-- shown, and the old constraint forced the whole document out of ACTIVE to record it. That took healthy
-- published v1 out of retrieval over a problem in a draft.
--
-- The honest invariant is about the version customers are answered with: an ACTIVE document may carry a
-- failure, but not for the version it is publishing.
ALTER TABLE "knowledge_documents" DROP CONSTRAINT "knowledge_documents_failed_not_active_check";

ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_failed_not_active_check" CHECK (
  NOT (
    "status" = 'ACTIVE'
    AND "indexing_state" = 'FAILED'
    AND ("published_version" IS NULL OR "published_version" = "version")
  )
);
