-- Every invariant trigger in this schema fires in replica mode too.
--
-- Found by an adversarial review of the P5-06 history repair, and it applies to all of them: a trigger
-- created with a plain `CREATE TRIGGER` has `pg_trigger.tgenabled = 'O'`, origin-only. In replica mode
-- only `'A'` (ENABLE ALWAYS) and `'R'` fire, so
--
--     SET session_replication_role = 'replica';
--
-- makes every one of them silent for the rest of the session. That is not a privileged operation and not
-- DDL: it is a plain `SET`, available to the application's own connection, and afterwards `pg_trigger`
-- is unchanged — so an audit that inspects the catalogue still reports every trigger present and enabled.
-- Demonstrated before this migration was written: an append-only row reading `CHANGES_REQUESTED` was
-- rewritten to `PASS` by one `SET` and one `UPDATE`, with the flag untouched.
--
-- Two classes are at stake and the second is worse.
--
-- **The immutability guards refuse a write, so their silence at least leaves a trace in the data.**
-- `platform_audit_events_no_change` protects the record of what an operator did; the two
-- `support_access_sessions` guards protect the record of who unlocked a customer's correspondence;
-- `legal_acceptances_no_change` and `legal_documents_no_change` protect what somebody consented to and
-- what they were shown; `billing_events_no_change` protects a verified provider event; the catalogue and
-- release guards protect published prices and recorded release decisions. Each of those tables exists
-- because its rows are evidence, and evidence that can be edited by anybody who can also run `SET` is
-- evidence of nothing in particular.
--
-- **The advisory-lock triggers refuse nothing, so their silence leaves no trace at all.** This is the
-- half worth the migration on its own. `automation_suspensions_take_key` is what orders a kill switch
-- against a delivery claim already in flight; the four `entitlement_take_key` triggers order a plan
-- change against one; the three `release_catalogue_take_key` triggers order a recorded release against
-- one. Each exists because the fact a claim re-reads can be written by something that never went through
-- a store method — a support script, a migration, a hand-typed statement during an incident — and the
-- trigger is what makes that writer participate in the ordering anyway. Under replica mode the lock is
-- simply not taken: nothing is refused, nothing is logged, every test still passes, and the race the lock
-- was bought to prevent is back. For the kill switch that race is a reply going out after somebody
-- stopped outbound.
--
-- **This does not affect restoring a backup**, which was the reason to hesitate. `pg_dump
-- --disable-triggers` emits `ALTER TABLE ... DISABLE TRIGGER ALL`, which is owner DDL and turns an
-- `ALWAYS` trigger off as readily as an origin-only one — checked rather than assumed, by dumping and
-- restoring a table carrying one of each. `pg_dump --schema-only` also emits the `ENABLE ALWAYS` line
-- back, so the property survives a dump and restore rather than being quietly downgraded.
--
-- What stays open is DDL on the table by its owner: `ALTER TABLE ... DISABLE TRIGGER`, `DROP TRIGGER`,
-- `DROP TABLE`, or `CREATE OR REPLACE FUNCTION` on the body. No trigger can close that, and a backup
-- restore legitimately needs it. So the claim these tables can make is "unrewritable by anything short of
-- DDL on the table itself" — which is a different and much stronger thing than "nothing in this package
-- edits these rows", and is as far as a trigger reaches. Where a comment or a document said more than
-- that, it is corrected rather than left to be read.
--
-- One note on how this list was built, because it matters for whoever adds the next trigger. A first pass
-- read the `CREATE TRIGGER` statements out of the migration files and missed five of them, purely because
-- they are written in a different shape. The list below comes from `pg_trigger` on a freshly migrated
-- database, and the regression in `constraints.integration.test.ts` asserts against that catalogue rather
-- than against the files — so a trigger added later without this line fails a test instead of leaving a
-- hole nobody is looking for.

-- ---------------------------------------------------------------------------------------------------------
-- Immutability and append-only guards
-- ---------------------------------------------------------------------------------------------------------
-- The customer's own audit log. Its rows are what a business is shown when they ask what happened in
-- their workspace, and they were editable by anybody who could also run one `SET`.
ALTER TABLE "audit_events" ENABLE ALWAYS TRIGGER "audit_events_no_update";
ALTER TABLE "audit_events" ENABLE ALWAYS TRIGGER "audit_events_no_delete";

-- Published plan versions, and this pair is load-bearing in a way the others are not. The delivery claim
-- reads `plan_versions` and `plan_definitions` *without a lock*, and the reason written into
-- `delivery-store.integration.test.ts` is precisely that they cannot be updated: "a row that cannot be
-- updated cannot be invalidated between the read and the claim, which is the only thing a lock here would
-- be protecting against." That argument rested on an origin-only trigger.
ALTER TABLE "plan_versions" ENABLE ALWAYS TRIGGER "plan_versions_immutable_trigger";
ALTER TABLE "plan_versions" ENABLE ALWAYS TRIGGER "plan_versions_no_delete_trigger";

ALTER TABLE "plan_prices" ENABLE ALWAYS TRIGGER "plan_prices_no_change";
ALTER TABLE "addon_prices" ENABLE ALWAYS TRIGGER "addon_prices_no_change";
ALTER TABLE "addon_versions" ENABLE ALWAYS TRIGGER "addon_versions_no_update";
ALTER TABLE "addon_versions" ENABLE ALWAYS TRIGGER "addon_versions_no_delete";
ALTER TABLE "billing_events" ENABLE ALWAYS TRIGGER "billing_events_no_change";
ALTER TABLE "checkout_contracts" ENABLE ALWAYS TRIGGER "checkout_contracts_no_change";
ALTER TABLE "checkout_contracts" ENABLE ALWAYS TRIGGER "checkout_contracts_no_delete";
ALTER TABLE "legal_documents" ENABLE ALWAYS TRIGGER "legal_documents_no_change";
ALTER TABLE "legal_acceptances" ENABLE ALWAYS TRIGGER "legal_acceptances_no_change";
ALTER TABLE "platform_audit_events" ENABLE ALWAYS TRIGGER "platform_audit_events_no_change";
ALTER TABLE "support_access_sessions" ENABLE ALWAYS TRIGGER "support_access_sessions_no_change";
ALTER TABLE "support_access_sessions" ENABLE ALWAYS TRIGGER "support_access_sessions_no_delete";
ALTER TABLE "release_records" ENABLE ALWAYS TRIGGER "release_records_no_change";
ALTER TABLE "release_gate_results" ENABLE ALWAYS TRIGGER "release_gate_results_no_change";
ALTER TABLE "release_reviews" ENABLE ALWAYS TRIGGER "release_reviews_no_change";

-- The truncate guards, for the same reason and with the same reach: a statement-level trigger is subject
-- to `tgenabled` exactly as a row trigger is, so without this the one statement that destroys every row
-- is also the one a `SET` could permit.
ALTER TABLE "release_records" ENABLE ALWAYS TRIGGER "release_records_no_truncate";
ALTER TABLE "release_gate_results" ENABLE ALWAYS TRIGGER "release_gate_results_no_truncate";
ALTER TABLE "release_reviews" ENABLE ALWAYS TRIGGER "release_reviews_no_truncate";

-- ---------------------------------------------------------------------------------------------------------
-- Advisory-lock ordering
-- ---------------------------------------------------------------------------------------------------------
-- The half that fails silently. Each of these is the writer's side of a key a delivery claim takes in
-- shared mode, and the whole point of putting it in a trigger rather than in a store method was to bind
-- writers who never went through the store.
ALTER TABLE "automation_suspensions" ENABLE ALWAYS TRIGGER "automation_suspensions_take_key";
ALTER TABLE "workspace_subscriptions" ENABLE ALWAYS TRIGGER "workspace_subscriptions_take_key";
ALTER TABLE "entitlement_overrides" ENABLE ALWAYS TRIGGER "entitlement_overrides_take_key";
ALTER TABLE "workspace_addons" ENABLE ALWAYS TRIGGER "workspace_addons_take_key";
ALTER TABLE "billing_arrangements" ENABLE ALWAYS TRIGGER "billing_arrangements_take_key";
ALTER TABLE "release_records" ENABLE ALWAYS TRIGGER "release_records_take_key";
ALTER TABLE "release_gate_results" ENABLE ALWAYS TRIGGER "release_gate_results_take_key";
ALTER TABLE "release_reviews" ENABLE ALWAYS TRIGGER "release_reviews_take_key";

-- ---------------------------------------------------------------------------------------------------------
-- Row validators
-- ---------------------------------------------------------------------------------------------------------
-- These two check a property of the row being written, which is true however the row arrived, so they
-- belong with the guards above.
ALTER TABLE "legal_acceptances" ENABLE ALWAYS TRIGGER "legal_acceptances_applicable_trigger";
ALTER TABLE "release_reviews" ENABLE ALWAYS TRIGGER "release_reviews_not_future";
ALTER TABLE "checkout_contracts" ENABLE ALWAYS TRIGGER "checkout_contracts_acceptance_present";

-- `release_gate_results_sealed` is deliberately left origin-only, and it is the one exception worth
-- stating. It does not check a property of the row; it checks a property of the *transaction* that wrote
-- it — that the parent candidate was created by the same one. A replication apply, and a data-only
-- restore that inserts parents and children separately, are both legitimate writers that cannot satisfy
-- that, so firing in replica mode would refuse the one case the mode exists for. Its guarantee is
-- therefore weaker than the others by nature rather than by omission: it binds the application's writes,
-- and the append-only guard above is what binds everything afterwards.
