-- More than membership belongs to the workspace rather than to one Business Profile (#38, #57).
--
-- A workspace pays for a plan, not a profile, so a subscription change and an entitlement override name
-- no profile. Neither does a deletion whose scope is the whole tenant. Filing any of them under one
-- profile would hide them from the only view where they make sense — and the previous CHECK made writing
-- them impossible rather than merely awkward.
--
-- Still exact rather than permissive: a kind that *is* about one profile must still name one, or the
-- Business Profile audit view would quietly lose rows.
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_scope_check";

ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_scope_check" CHECK (
  (
    "kind" IN ('MEMBER_CHANGED', 'SUBSCRIPTION_CHANGED', 'ENTITLEMENT_OVERRIDDEN', 'DELETION_REQUESTED', 'DELETION_COMPLETED')
    AND "business_profile_id" IS NULL
  )
  OR (
    "kind" NOT IN ('MEMBER_CHANGED', 'SUBSCRIPTION_CHANGED', 'ENTITLEMENT_OVERRIDDEN')
    AND "business_profile_id" IS NOT NULL
  )
);
