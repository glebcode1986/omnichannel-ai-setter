-- Ordering a kill switch against the delivery claims it would cover, at the database boundary (Issue #56).
--
-- The claim takes, in shared mode, an advisory key for every scope that could cover the send it is about
-- to take. That only orders anything if every writer of this table takes the matching key exclusively —
-- and doing it in application code made it a convention rather than a rule. `RELIABILITY_INCIDENTS.md`
-- says outright that this is a table people write to by hand during an incident, and there is no operator
-- HTTP surface in this version, so a direct INSERT is not an exotic bypass: it is the documented way an
-- operator turns the switch on. A trigger is therefore the only place the ordering can actually live.
--
-- It fires on UPDATE and DELETE as well. Coverage is not only created: a row edited by hand can start
-- covering a target it did not, and one deleted can stop. Taking both the old and the new key means the
-- set of switches covering a send cannot change underneath a claim that holds the keys, whatever shape
-- the write takes.
--
-- The key strings are the same four this codebase builds in `packages/db/src/suspension-lock.ts`, and a
-- test asserts the two derivations hash identically — two spellings of one convention is exactly how a
-- mechanism like this stops working without anyone noticing.

CREATE OR REPLACE FUNCTION "automation_suspension_key"(
    scope "SuspensionScope",
    workspace_id TEXT,
    business_profile_id TEXT,
    channel_account_id TEXT
) RETURNS TEXT AS $$
    SELECT CASE scope
        WHEN 'GLOBAL' THEN 'GLOBAL'
        WHEN 'WORKSPACE' THEN 'WORKSPACE:' || COALESCE(workspace_id, '')
        WHEN 'BUSINESS_PROFILE' THEN 'BUSINESS_PROFILE:' || COALESCE(workspace_id, '') || ':' || COALESCE(business_profile_id, '')
        WHEN 'CHANNEL_ACCOUNT' THEN 'CHANNEL_ACCOUNT:' || COALESCE(workspace_id, '') || ':' || COALESCE(channel_account_id, '')
    END
$$ LANGUAGE SQL IMMUTABLE;

CREATE OR REPLACE FUNCTION "automation_suspension_take_key"() RETURNS TRIGGER AS $$
DECLARE
    new_key TEXT;
    old_key TEXT;
BEGIN
    IF TG_OP <> 'DELETE' THEN
        new_key := "automation_suspension_key"(NEW."scope", NEW."workspace_id", NEW."business_profile_id", NEW."channel_account_id");
        PERFORM pg_advisory_xact_lock(hashtextextended(new_key, 0));
    END IF;
    IF TG_OP <> 'INSERT' THEN
        old_key := "automation_suspension_key"(OLD."scope", OLD."workspace_id", OLD."business_profile_id", OLD."channel_account_id");
        -- Only when it differs: re-acquiring is harmless, but saying so keeps the intent readable.
        IF new_key IS DISTINCT FROM old_key THEN
            PERFORM pg_advisory_xact_lock(hashtextextended(old_key, 0));
        END IF;
    END IF;
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "automation_suspensions_take_key"
    BEFORE INSERT OR UPDATE OR DELETE ON "automation_suspensions"
    FOR EACH ROW EXECUTE FUNCTION "automation_suspension_take_key"();
