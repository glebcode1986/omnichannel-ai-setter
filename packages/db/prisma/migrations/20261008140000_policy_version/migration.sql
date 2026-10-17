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

-- The history is read newest-first, ordered by the `(changed_at, id)` pair, and this index is that order.
--
-- What the index does **not** do is make the cursor a seek, and it is worth recording what it does instead
-- rather than assuming, because the answer is not the obvious one. Prisma emits the page predicate as
-- `changed_at < $1 OR (changed_at = $1 AND id < $2)`, and measured here on 200k rows with exactly this
-- index, Postgres 17 picks one of two plans depending on how selective the cursor is:
--
--   * deep cursor  — `BitmapOr` over this index and the primary key, then a Bitmap Heap Scan, then an
--                    explicit `Sort`. So the OR *is* answered from indexes, and the ordering this index
--                    exists to provide is thrown away and recomputed.
--   * shallow one  — `Index Only Scan` with the whole OR as a `Filter`.
--
-- A row comparison (`(changed_at, id) < ($1, $2)`) is a single `Index Only Scan` with the cursor as an
-- `Index Cond`, no heap fetch and no sort. That is the shape worth having, and it needs `$queryRaw` plus a
-- hand-written mapping of the actor join — a second statement of the Prisma `select` to keep in step. A
-- workspace's own policy history is a few hundred rows, so the trade is not worth it today; the plans are
-- written down so the next person does not re-derive them, and the index stays because the order it
-- describes is the order this table is read in.
--
-- Resumability itself comes from the pair being unique — `id` is the primary key — not from this index.
DROP INDEX IF EXISTS "policy_change_audits_history_idx";
CREATE INDEX "policy_change_audits_history_idx"
  ON "policy_change_audits" ("workspace_id", "business_profile_id", "changed_at" DESC, "id" DESC);
