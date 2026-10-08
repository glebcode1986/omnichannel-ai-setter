-- A style example's lifecycle cannot be rewritten (#32, P5-06, R5 re-review).
--
-- `style_example_decisions` was described as "append-only by use": nothing in `style-store.ts` updates or
-- deletes one of these rows, and the foreign key means the example they describe cannot be deleted while
-- they point at it. Neither of those is a guarantee about the rows themselves. The foreign keys protect
-- the *parents*; "nothing in this store does it" is a statement about one package's current source, and a
-- support script, a migration or a hand-typed `UPDATE` during an incident is exactly the case where that
-- statement is not the one running.
--
-- So the guarantee moves to the database, where it is a property of the table rather than of one package's
-- source. Both triggers are `ENABLE ALWAYS` for a reason spelled out below: created the ordinary way they
-- would be switched off by a single `SET session_replication_role = 'replica'`.
-- The quiet edit is the one that matters: turning a `REJECTED` into an `APPROVED`, or deleting the row
-- that says who withdrew an example, leaves a history that reads as complete and is not. That is the
-- difference between an audit trail and a log somebody could have tidied.
--
-- `RAISE EXCEPTION` with the default SQLSTATE (P0001) on purpose: a client library rewrites a
-- constraint-shaped code into its own wording and the reason is lost, while a raised exception arrives as
-- written. No caller wants a typed refusal from it, because no caller in the product attempts either
-- operation — a refusal here means somebody is doing something this table does not permit at all.
CREATE OR REPLACE FUNCTION "style_example_decisions_append_only"() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'style example decisions are append-only: a lifecycle is recorded, never corrected';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "style_example_decisions_no_change"
    BEFORE UPDATE OR DELETE ON "style_example_decisions"
    FOR EACH ROW EXECUTE FUNCTION "style_example_decisions_append_only"();

-- `ENABLE ALWAYS`, and this line is most of what makes the guarantee real.
--
-- A plain `CREATE TRIGGER` is origin-only: `pg_trigger.tgenabled` is `'O'`, and in replica mode only
-- `'A'` and `'R'` fire. So `SET session_replication_role = 'replica'` would switch the whole thing off
-- for the session in one statement — no DDL, nothing recorded, both triggers still listed and still
-- reported as enabled afterwards. That is not a theoretical privilege: it is a plain `SET`, available to
-- the ordinary connection, and it is the same mechanism `pg_restore --disable-triggers` uses.
--
-- What remains open is the owner's path — `ALTER TABLE ... DISABLE TRIGGER`, `DROP TRIGGER`, `DROP TABLE`,
-- or replacing the function body — and that genuinely cannot be closed by a trigger. It is worth being
-- exact about the claim: this makes the history unrewritable by anything short of DDL on the table
-- itself, which is a different and much stronger thing than "nothing in this package edits these rows",
-- and it is as far as a trigger reaches.
ALTER TABLE "style_example_decisions" ENABLE ALWAYS TRIGGER "style_example_decisions_no_change";

-- And `TRUNCATE`, which the trigger above cannot see.
--
-- A row trigger never fires for `TRUNCATE`, and `TRUNCATE "style_example_decisions"` would be refused
-- only if some other table referenced it — nothing does. So without this, the append-only guarantee would
-- end at the single statement that destroys every row rather than editing one, which is the wrong way
-- round: the more complete the destruction, the less this table would have had to say about it.
--
-- Statement-level, because that is the only timing `TRUNCATE` has.
CREATE OR REPLACE FUNCTION "style_example_decisions_no_truncate"() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'style example decisions are append-only: they cannot be truncated';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "style_example_decisions_no_truncate"
    BEFORE TRUNCATE ON "style_example_decisions"
    FOR EACH STATEMENT EXECUTE FUNCTION "style_example_decisions_no_truncate"();

ALTER TABLE "style_example_decisions" ENABLE ALWAYS TRIGGER "style_example_decisions_no_truncate";

-- The index the complete lifecycle is paged by.
--
-- The existing index was `(workspace_id, style_example_id, decided_at)` ascending, which served a read
-- that took the twenty oldest decisions. The lifecycle is now paged newest-first with `(decided_at, id)`
-- as a keyset — `decided_at` alone is not unique, and a cursor on an instant with no tiebreak silently
-- repeats or skips rows, which on a page of audit history reads as events appearing twice or vanishing.
-- Descending, with `id` in the index, so the page is an index scan rather than a sort of the whole
-- lifecycle.
--
-- The ascending one is dropped rather than left beside it. Nothing orders these rows ascending any more,
-- and two indexes on an append-only table are two writes per decision — one of them for a query shape
-- this change removed.
DROP INDEX "style_example_decisions_workspace_id_style_example_id_decid_idx";

CREATE INDEX "style_example_decisions_lifecycle_idx"
  ON "style_example_decisions" ("workspace_id", "style_example_id", "decided_at" DESC, "id" DESC);
