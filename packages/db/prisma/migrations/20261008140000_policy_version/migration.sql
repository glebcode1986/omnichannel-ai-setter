-- A policy row carries the number of times it has been written (AI_CONFIGURATION_UX.md, Issue #30).
--
-- Two owners editing the same settings in two tabs each read the whole form, and the second save used to
-- win silently: it posted every field from a snapshot taken before the first save, so it reverted changes
-- its author had never seen, and both audit rows derived their `before` from the same stale state. The
-- form now carries the version it was rendered from, and a save whose version is not the stored one is
-- refused rather than applied.
--
-- An integer rather than `updated_at`: two writes inside the same millisecond would compare equal on a
-- `TIMESTAMP(3)` column, and "the second writer saw the first one's result" is exactly what must not be
-- assumed by accident. The counter only ever increases, so the comparison cannot be satisfied by chance.
ALTER TABLE "automation_policies" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- A version below the initial one would mean a counter that went backwards, which no path writes and
-- nothing downstream could interpret.
ALTER TABLE "automation_policies" ADD CONSTRAINT "automation_policies_version_check" CHECK ("version" >= 1);

-- The history is read newest-first in pages, ordered by the `(changed_at, id)` pair, and this index is
-- that order: it removes the sort, so a page is an index-only scan rather than a scan plus a sort.
--
-- What it does **not** do is turn the cursor into an index bound. The page predicate is expressed as
-- `changed_at < $1 OR (changed_at = $1 AND id < $2)`, and Postgres cannot use a two-arm OR as a seek — it
-- scans from the start of the key and filters, so a deep page costs O(offset). A row comparison
-- (`(changed_at, id) < ($1, $2)`) is searchable and would make it a true seek, at the price of raw SQL on
-- this read path. Measured at 200k rows the difference is 14ms against 0.03ms; a workspace's own policy
-- history is a few hundred rows, so the sort is the part worth removing and the seek is not yet worth the
-- raw SQL. Stated rather than implied, because "resumable" and "cheap to resume" are different claims.
--
-- Resumability itself comes from the pair being unique — `id` is the primary key — not from this index.
DROP INDEX IF EXISTS "policy_change_audits_history_idx";
CREATE INDEX "policy_change_audits_history_idx"
  ON "policy_change_audits" ("workspace_id", "business_profile_id", "changed_at" DESC, "id" DESC);
