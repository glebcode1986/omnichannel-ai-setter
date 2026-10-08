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

-- The history is read newest-first in pages, and the page boundary is the `(changed_at, id)` pair: the
-- previous index stopped at `changed_at`, so two rows sharing an instant left the second page's starting
-- point to the planner. The pair is unique, which is what makes a cursor resumable.
DROP INDEX IF EXISTS "policy_change_audits_history_idx";
CREATE INDEX "policy_change_audits_history_idx"
  ON "policy_change_audits" ("workspace_id", "business_profile_id", "changed_at" DESC, "id" DESC);
