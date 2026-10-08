-- A customer's erasure may remove a style example's lifecycle; nothing else may (#32 and #57 together).
--
-- Two accepted requirements met here for the first time, because they were built on different branches.
--
-- `20261008100000_style_decisions_append_only` makes `style_example_decisions` append-only: the lifecycle
-- of a style example is evidence about who approved and who withdrew it, and evidence that can be edited
-- is evidence of nothing in particular.
--
-- `PRIVACY_RETENTION_DELETION.md` requires that a deletion request remove what was learned from the
-- person who asked — and a style example quotes their own words. `deletion-store.ts` deletes the
-- examples, and the foreign key is `RESTRICT`, so it must delete their decisions first. With the trigger
-- in place that `DELETE` was refused, the whole purge transaction aborted, and every deletion request
-- ended `PARTIAL_FAILURE`. A privacy deletion that silently removes nothing is the worse of the two
-- failures by a distance.
--
-- The resolution is not to weaken the guarantee but to say what it is a guarantee *about*. The trigger
-- exists so that a lifecycle cannot be **rewritten**; it was never meant to say that a person's data
-- cannot be **erased**. So:
--
-- - `UPDATE` stays refused unconditionally. An erasure removes rows; it never changes a verdict, and the
--   edit this table exists to prevent — a `REJECTED` quietly becoming an `APPROVED` — is an update.
-- - `TRUNCATE` stays refused unconditionally, by its own trigger.
-- - `DELETE` is permitted only while a session says, in as many words, that it is carrying out a
--   customer erasure.
--
-- `SET LOCAL` is what makes that narrow: the setting lives for one transaction and cannot leak past the
-- commit, so "deleting as part of an erasure" is a statement a caller makes about one transaction rather
-- than a mode the application can be left in. `purge()` sets it inside the transaction that does the
-- work, and nothing else in the repository sets it.
--
-- It is worth being honest about what this is not. Anybody who can run `SET LOCAL` can delete these
-- rows, just as anybody who can run `ALTER TABLE ... DISABLE TRIGGER` can. The guarantee is therefore
-- "a lifecycle cannot be rewritten, and cannot be removed except by a deliberate, named act" — which is
-- what an erasure is, and which is recorded: `executeDeletion` writes an audit row counting every table
-- it emptied, and that audit is append-only itself.
CREATE OR REPLACE FUNCTION "style_example_decisions_append_only"() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' AND current_setting('omnichannel.erasing_customer_data', true) = 'on' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'style example decisions are append-only: a lifecycle is recorded, never corrected';
END;
$$ LANGUAGE plpgsql;
