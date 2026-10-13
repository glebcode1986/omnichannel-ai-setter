-- Release candidates, launch-gate verdicts and independent review (#60, LAUNCH_READINESS.md).
--
-- The spec's first sentence decides the shape of all three tables: "production release is an exact-SHA
-- decision supported by reproducible evidence. 'Looks fine' is not a launch criterion."
--
-- Two design choices are worth reading before the SQL, because both are the opposite of the obvious one.
--
-- **Nothing judged is stored.** There is no `releasable` column and no `reviewer_status` column. Both are
-- functions of the gate results and the review rows, and a stored copy is a second answer that can
-- disagree with the inputs it was computed from — which is how a release record comes to say "approved"
-- about a commit whose gates say otherwise. `releaseDecision` and `reviewerStatusOf` in
-- `packages/domain/src/release.ts` recompute them on every read.
--
-- **A verdict about the wrong commit is recordable and does not count.** `release_reviews.reviewed_sha`
-- is deliberately not constrained to equal the release's own SHA. The naive CHECK would have destroyed
-- the evidence instead of interpreting it: a verdict given to an earlier commit has to be *visible*,
-- because its existence is the fact somebody needs to see. This repository has had a stale
-- `CHANGES_REQUESTED` sitting on one SHA while the branch head was two commits further on, and the whole
-- danger was that it read as current. So the database records any verdict about any commit, and the
-- domain decides which one counts: the newest whose reviewed SHA *is* this release's, and no other.
--
-- That is also why `release_reviews` has no foreign key to `release_records` and is keyed by the SHA it
-- names instead. A verdict is about a commit, not about a proposal: a reviewer who passed a commit has
-- passed it, and tying the row to one proposal would mean the same commit proposed again at the next
-- stage of §18's progression arrived unreviewed. A verdict may therefore be filed for a commit nobody has
-- proposed yet, which is a reviewer being early rather than an error.
--
-- **One commit may be proposed at several stages, once each.** §18 is a progression — "limited AUTOPILOT"
-- then "Commercial Beta" — and advancing it is a release decision with its own evidence and its own
-- reviewer status, not an edit to an earlier one. So the unique key is (`sha`, `stage`) rather than `sha`:
-- re-running the release script for a stage already recorded is refused, and advancing a stage is a new
-- row. Nothing is ever edited; pulling a rollout back *during an incident* is the kill switch's job,
-- which is immediate and needs no reviewer, and not this table's.
-- CreateEnum
CREATE TYPE "RolloutStage" AS ENUM ('INTERNAL', 'DESIGN_PARTNERS_DRAFT', 'LIMITED_AUTOPILOT', 'COMMERCIAL_BETA', 'GENERAL_AVAILABILITY');

-- CreateEnum
CREATE TYPE "GateSeverity" AS ENUM ('PASS', 'KNOWN_LIMITATION', 'HIGH', 'BLOCKER');

-- CreateEnum
CREATE TYPE "ReviewVerdict" AS ENUM ('PASS', 'CHANGES_REQUESTED');

-- AlterTable
-- The explicit list §18 calls for at the `LIMITED_AUTOPILOT` stage. Defaults to false, because the spec's
-- own default is DRAFT and AUTOPILOT "requires explicit enablement" — so a profile that nobody has
-- selected is a profile that does not send unattended during a limited rollout.
ALTER TABLE "business_profiles" ADD COLUMN     "rollout_autopilot" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "release_records" (
    "id" TEXT NOT NULL,
    "sha" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "stage" "RolloutStage" NOT NULL,
    "rollback_plan" TEXT NOT NULL,
    "migrations" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled_flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "summary" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "release_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "release_gate_results" (
    "id" TEXT NOT NULL,
    "release_id" TEXT NOT NULL,
    "gate_id" TEXT NOT NULL,
    "severity" "GateSeverity" NOT NULL,
    "evidence" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "release_gate_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "release_reviews" (
    "id" TEXT NOT NULL,
    "reviewer" TEXT NOT NULL,
    "verdict" "ReviewVerdict" NOT NULL,
    "reviewed_sha" TEXT NOT NULL,
    "reference" TEXT,
    "submitted_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "release_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "release_records_sha_stage_key" ON "release_records"("sha", "stage");

-- CreateIndex
CREATE INDEX "release_records_sha_idx" ON "release_records"("sha");

-- CreateIndex
CREATE INDEX "release_records_created_at_idx" ON "release_records"("created_at");

-- CreateIndex
CREATE INDEX "release_records_stage_created_at_idx" ON "release_records"("stage", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "release_gate_results_release_id_gate_id_key" ON "release_gate_results"("release_id", "gate_id");

-- CreateIndex
CREATE INDEX "release_reviews_reviewed_sha_submitted_at_idx" ON "release_reviews"("reviewed_sha", "submitted_at");

-- AddForeignKey
ALTER TABLE "release_records" ADD CONSTRAINT "release_records_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "release_gate_results" ADD CONSTRAINT "release_gate_results_release_id_fkey" FOREIGN KEY ("release_id") REFERENCES "release_records"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;



-- ---------------------------------------------------------------------------------------------------------
-- Invariants Prisma cannot express (#60)
-- ---------------------------------------------------------------------------------------------------------

/*
  A release names one exact commit, in full.

  Forty lowercase hexadecimal characters, and the strictness is the point: `LAUNCH_READINESS.md` §1 asks
  for "one immutable commit SHA", and an abbreviated form is exactly how a verdict given to one commit
  comes to be read as a verdict about another — `a3d27e3` and `a3d27e39d479a5c00ea5ebea2e6af9216e869e17`
  look like the same thing to a person and are not the same string to `reviewerStatusOf`.

  A rollback plan and a summary are required for the same reason the audit requires a reason: a release
  nobody can explain, or cannot get back from, is one nobody should be able to record as considered.
*/
--
-- `~ '[^[:space:]]'` rather than `btrim(...) <> ''`, and the difference is not pedantry: bare `btrim`
-- trims U+0020 and nothing else, so a single tab is a rollback plan as far as it is concerned. The
-- character-class test asks the question actually meant — is there anything here that is not whitespace.
ALTER TABLE "release_records" ADD CONSTRAINT "release_records_shape_check" CHECK (
  "sha" ~ '^[0-9a-f]{40}$'
  AND "rollback_plan" ~ '[^[:space:]]'
  AND "summary" ~ '[^[:space:]]'
);

/*
  Evidence is required for every verdict, including a pass.

  The spec: "do not rely on 'Claude ran it locally' without recorded commands/results". A `PASS` with an
  empty evidence column is that claim exactly, so it is refused here as well as by `releaseDecision` —
  the domain's version produces a readable refusal, and this one holds for a row written by hand.

  A `KNOWN_LIMITATION` additionally needs a note, because the spec admits one only when it is "explicit,
  bounded and safe" and an unbounded limitation is none of the three.
*/
ALTER TABLE "release_gate_results" ADD CONSTRAINT "release_gate_results_evidence_check" CHECK (
  "evidence" ~ '[^[:space:]]'
  AND ("severity" <> 'KNOWN_LIMITATION' OR ("note" IS NOT NULL AND "note" ~ '[^[:space:]]'))
);

-- A verdict names a reviewer, a full commit and a time. The commit may differ from the release's; see the
-- header. What it may not be is absent or abbreviated, which would make "which commit was this about?"
-- unanswerable — the one question the row exists to answer.
ALTER TABLE "release_reviews" ADD CONSTRAINT "release_reviews_shape_check" CHECK (
  "reviewer" ~ '[^[:space:]]' AND "reviewed_sha" ~ '^[0-9a-f]{40}$'
);

/*
  All three are evidence, so all three are immutable.

  A release record that could be edited after the fact is a release record nobody can rely on, and the
  edit that matters is the quiet one: raising a `BLOCKER` to a `PASS`, or moving a `reviewed_sha` onto the
  commit that needed it. A correction is a new release candidate with its own SHA, which is what the spec
  means by an exact-SHA decision.
*/
CREATE OR REPLACE FUNCTION "release_evidence_append_only"() RETURNS TRIGGER AS $$
BEGIN
    -- The default SQLSTATE (P0001) on purpose: a client library rewrites a constraint-shaped code into
    -- its own wording and the reason is lost, while a raised exception arrives as written.
    RAISE EXCEPTION 'release evidence is append-only: record a new release candidate instead of editing one';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "release_records_no_change"
    BEFORE UPDATE OR DELETE ON "release_records"
    FOR EACH ROW EXECUTE FUNCTION "release_evidence_append_only"();

CREATE TRIGGER "release_gate_results_no_change"
    BEFORE UPDATE OR DELETE ON "release_gate_results"
    FOR EACH ROW EXECUTE FUNCTION "release_evidence_append_only"();

CREATE TRIGGER "release_reviews_no_change"
    BEFORE UPDATE OR DELETE ON "release_reviews"
    FOR EACH ROW EXECUTE FUNCTION "release_evidence_append_only"();

/*
  And `TRUNCATE`, which the triggers above cannot see.

  A row trigger never fires for `TRUNCATE`, and `TRUNCATE "release_reviews", "release_gate_results",
  "release_records";` satisfies the foreign keys by naming every referencing table in one statement. So
  without this the append-only guarantee ends at the one statement that destroys everything rather than
  editing one thing — and the destruction lands in the *permissive* direction: an empty catalogue reports
  no stage in force, and no stage in force is the only state in which the §18 gate permits everybody.

  Statement-level, because that is the only timing `TRUNCATE` has.
*/
CREATE OR REPLACE FUNCTION "release_evidence_no_truncate"() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'release evidence is append-only: it cannot be truncated';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "release_records_no_truncate"
    BEFORE TRUNCATE ON "release_records"
    FOR EACH STATEMENT EXECUTE FUNCTION "release_evidence_no_truncate"();

CREATE TRIGGER "release_gate_results_no_truncate"
    BEFORE TRUNCATE ON "release_gate_results"
    FOR EACH STATEMENT EXECUTE FUNCTION "release_evidence_no_truncate"();

CREATE TRIGGER "release_reviews_no_truncate"
    BEFORE TRUNCATE ON "release_reviews"
    FOR EACH STATEMENT EXECUTE FUNCTION "release_evidence_no_truncate"();

/*
  A candidate's gate results are written with it, and never afterwards.

  This is the hole immutability alone leaves open, and it is the sharpest one in the design: `releasable`
  is derived from the child rows, so the verdict of a sealed, unedited record can still be changed — by
  *appending*. A candidate recorded with nineteen of the twenty gates is refused with
  `GATE_NOT_EVALUATED`; one later `INSERT` supplying the twentieth as a `PASS` makes it releasable, with
  no `UPDATE` for the append-only trigger to catch and no new SHA. The record would then be read as
  evidence of a release decision that nobody ever made.

  So the results belong to the transaction that created the candidate, and the test is literally that:
  the parent row's `xmin` is the id of the transaction that inserted it, so comparing it with
  `pg_current_xact_id()` asks "did I insert this row" with no other moving part.

  Comparing timestamps instead was the obvious version and it is wrong in a way worth recording, because
  it failed *closed* and so looked like the guard working: `created_at` is `TIMESTAMP(3)` while
  `transaction_timestamp()` carries microseconds, so the two are unequal for rows written together and
  the trigger refused every legitimate write. A timestamp comparison would also have had to pick a time
  zone to compare a `timestamptz` against a `timestamp`.

  Reviews are deliberately not sealed this way: a reviewer arriving afterwards is the entire point of the
  table. Their equivalent guard is the one below.
*/
CREATE OR REPLACE FUNCTION "release_gate_results_sealed"() RETURNS TRIGGER AS $$
DECLARE
    same_transaction BOOLEAN;
BEGIN
    SELECT (parent.xmin = pg_current_xact_id()::xid)
      INTO same_transaction
      FROM "release_records" parent
     WHERE parent."id" = NEW."release_id";
    -- NULL covers a parent that does not exist, which the foreign key also refuses; saying so here means
    -- the refusal is this one's wording either way.
    IF same_transaction IS NOT TRUE THEN
        RAISE EXCEPTION 'gate results are written with the release candidate: record a new candidate instead of adding to one';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "release_gate_results_sealed"
    BEFORE INSERT ON "release_gate_results"
    FOR EACH ROW EXECUTE FUNCTION "release_gate_results_sealed"();

/*
  A verdict is about a moment that has already happened.

  `submitted_at` is supplied by the caller — it has to be, because it is when the reviewer actually said
  it, not when the row reached us — and `reviewerStatusOf` takes the newest matching verdict. Together
  those make a future timestamp permanent: a `PASS` stamped 2099 outranks every genuine
  `CHANGES_REQUESTED` that follows, the row cannot be edited or deleted, and the SHA it approves cannot be
  withdrawn. A one-character typo would approve a commit for seventy years.

  A trigger rather than a CHECK, because a CHECK containing `now()` is validated only on write and makes
  the table's constraints a lie to anything that revalidates them, `pg_dump`/restore included.
*/
CREATE OR REPLACE FUNCTION "release_reviews_not_future"() RETURNS TRIGGER AS $$
BEGIN
    IF NEW."submitted_at" > transaction_timestamp() THEN
        RAISE EXCEPTION 'a review cannot be submitted in the future: %', NEW."submitted_at";
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "release_reviews_not_future"
    BEFORE INSERT ON "release_reviews"
    FOR EACH ROW EXECUTE FUNCTION "release_reviews_not_future"();
