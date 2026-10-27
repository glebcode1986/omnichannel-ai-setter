-- Ordering a delivery claim against a change of the staged rollout (#60).
--
-- The claim re-resolves the rollout immediately before it takes the send, because the stage in force is
-- computed rather than stored: it is the stage of the newest candidate whose gates permit a release and
-- whose own SHA an independent reviewer passed. Recording a candidate, recording its gate results, or
-- recording a verdict can therefore each change the answer, and none of them moves a row this claim could
-- bind with a predicate. A release committing between the read and the claim would simply be invisible,
-- which is the defect the kill switch's own lock exists to prevent.
--
-- A row lock cannot do it, for the reason `entitlement_change_lock` gives about an override: the candidate
-- that would change the answer may not exist yet when the claim starts, and a lock cannot be taken on a row
-- nobody has inserted. Here it is sharper — the answer is the *newest approved* candidate, so what
-- invalidates it is almost always an INSERT.
--
-- So: one advisory key, taken *shared* by claims and *exclusively* by this trigger on all three tables. The
-- trigger rather than application code, for the reason `suspension-lock.ts` gives — a lock taken in a store
-- method binds only callers who went through that method, and a release can be recorded by a script or a
-- gate result corrected by hand during an incident.
--
-- One key rather than one per workspace, because a release is platform-wide: `release_records` has no
-- workspace column, since "which stage is this deployment in" has one answer for everybody. Shared holders
-- do not block one another, so claims stay as concurrent as they were; the cost falls entirely on the
-- writer, which waits for the claims in flight and holds the ones that follow until it commits. For an
-- action that happens about once a deployment that is the ordering we want, not a price for it.
--
-- The key is spelled twice, here and in `release-lock.ts`; `release-lock.integration.test.ts` holds the two
-- derivations against each other for every table.
CREATE OR REPLACE FUNCTION "release_catalogue_key"() RETURNS TEXT AS $$
    SELECT 'RELEASE_CATALOGUE';
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION "release_catalogue_take_key"() RETURNS TRIGGER AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended("release_catalogue_key"(), 0));
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

-- All three tables and all three operations. The append-only trigger already refuses UPDATE and DELETE on
-- these tables, so in practice only the INSERT arm can fire; naming the other two anyway costs nothing and
-- means that relaxing append-only later — a correction path for a mistyped gate result, say — does not
-- silently drop the ordering this key exists for.
CREATE TRIGGER "release_records_take_key"
    BEFORE INSERT OR UPDATE OR DELETE ON "release_records"
    FOR EACH ROW EXECUTE FUNCTION "release_catalogue_take_key"();

CREATE TRIGGER "release_gate_results_take_key"
    BEFORE INSERT OR UPDATE OR DELETE ON "release_gate_results"
    FOR EACH ROW EXECUTE FUNCTION "release_catalogue_take_key"();

CREATE TRIGGER "release_reviews_take_key"
    BEFORE INSERT OR UPDATE OR DELETE ON "release_reviews"
    FOR EACH ROW EXECUTE FUNCTION "release_catalogue_take_key"();
