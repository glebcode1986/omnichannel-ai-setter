-- Ordering a delivery claim against a change of commercial state (#40).
--
-- The claim re-resolves the entitlement immediately before it takes the send, because entitlement changes
-- with the clock as well as with writes: a trial's last day can end, or an override lapse, while a reply
-- waits out its delay, and no row moves. That re-resolution is a read of two rows, and like every other
-- fact the claim depends on it must be ordered against whoever writes it — otherwise a subscription
-- committing between the read and the claim is simply invisible, which is the defect the kill switch's own
-- lock exists to prevent.
--
-- A row lock cannot do it. `entitlement_overrides` may not exist yet when the claim starts, and a lock
-- cannot be taken on a row nobody has inserted; the foreign-key trick the automation policies rely on —
-- inserting takes `KEY SHARE` on the parent the claim holds `FOR UPDATE` — would mean locking the
-- workspace row exclusively in every claim, which serializes claims across a whole workspace rather than
-- against the rare owner action that changes a plan.
--
-- So: an advisory key per workspace, taken *shared* by claims and *exclusively* by a trigger on both
-- tables. The trigger rather than application code, for the reason `suspension-lock.ts` gives — a lock
-- taken in a store method binds only callers who went through that method, and a plan can be changed by
-- a support script or by hand during an incident. Shared holders do not block one another, so claims stay
-- as concurrent as they were.
--
-- The key is spelled twice, here and in `entitlement-lock.ts`, which is exactly the drift this comment
-- would otherwise invite; `entitlement-lock.integration.test.ts` holds the two derivations against each
-- other for every table.
CREATE OR REPLACE FUNCTION "entitlement_change_key"(workspace_id TEXT) RETURNS TEXT AS $$
    SELECT 'ENTITLEMENT:' || COALESCE(workspace_id, '');
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION "entitlement_take_key"() RETURNS TRIGGER AS $$
DECLARE
    new_key TEXT;
    old_key TEXT;
BEGIN
    IF TG_OP <> 'DELETE' THEN
        new_key := "entitlement_change_key"(NEW."workspace_id");
        PERFORM pg_advisory_xact_lock(hashtextextended(new_key, 0));
    END IF;
    IF TG_OP <> 'INSERT' THEN
        old_key := "entitlement_change_key"(OLD."workspace_id");
        -- Only when it differs: re-acquiring is harmless, but saying so keeps the intent readable. A
        -- subscription cannot change workspace today, and binding both sides costs nothing if one ever can.
        IF new_key IS DISTINCT FROM old_key THEN
            PERFORM pg_advisory_xact_lock(hashtextextended(old_key, 0));
        END IF;
    END IF;
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "workspace_subscriptions_take_key"
    BEFORE INSERT OR UPDATE OR DELETE ON "workspace_subscriptions"
    FOR EACH ROW EXECUTE FUNCTION "entitlement_take_key"();

CREATE TRIGGER "entitlement_overrides_take_key"
    BEFORE INSERT OR UPDATE OR DELETE ON "entitlement_overrides"
    FOR EACH ROW EXECUTE FUNCTION "entitlement_take_key"();
