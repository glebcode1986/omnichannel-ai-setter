-- Every Business Profile has automation settings, including the ones created before it did.
--
-- Settings are stored per Business Profile and read by Business Profile, and nothing above this line has
-- a "no settings yet" state: the owner's settings screen renders the stored policy, so a profile without
-- one renders no form and offers no first save. Automation stays OFF and there is no way to change it.
-- `createBusinessProfile` now writes the default in the same statement as the profile, which fixes every
-- profile created from here on; the profiles created before this deploy are the ones this statement is
-- for.
--
-- The values are the schema's own defaults, which are the conservative ones the domain states for a new
-- profile: OFF, 0.8 confidence, 7-12s debounce, 30-120s delivery delay, a 6-hour takeover pause,
-- Instagram standard-only, WhatsApp service-window-only and an empty template allowlist. Only the
-- mandatory-review categories have to be named, because that column has no default — and it is the floor
-- the store re-adds on every write, so a backfilled row says exactly what a written one would.
--
-- Idempotent by `NOT EXISTS` rather than by `ON CONFLICT`: the unique index that would catch a duplicate
-- is partial (`channel_account_id IS NULL`), so an inferred conflict target is the fragile way to write
-- this. Re-running the statement inserts nothing. `gen_random_uuid()` and not a v7 id: these rows are
-- being given an identity after the fact, no part of the product reads an ordering out of this column,
-- and a migration cannot call the client's generator.
INSERT INTO "automation_policies" (
  "id",
  "workspace_id",
  "business_profile_id",
  "mandatory_review_reasons"
)
SELECT
  gen_random_uuid()::text,
  "profile"."workspace_id",
  "profile"."id",
  ARRAY[
    'MISSING_FACT',
    'PAYMENT_DISPUTE',
    'LEGAL_INTERPRETATION',
    'MEDICAL_OR_HIGH_RISK',
    'CREDENTIAL_OR_SECURITY',
    'REPUTATIONAL_COMPLAINT',
    'HIGH_VALUE_COMMITMENT',
    'UNSUPPORTED_PROMISE',
    'UNSUPPORTED_MEDIA'
  ]::TEXT[]
FROM "business_profiles" AS "profile"
WHERE NOT EXISTS (
  SELECT 1
  FROM "automation_policies" AS "policy"
  WHERE "policy"."workspace_id" = "profile"."workspace_id"
    AND "policy"."business_profile_id" = "profile"."id"
    AND "policy"."channel_account_id" IS NULL
);
