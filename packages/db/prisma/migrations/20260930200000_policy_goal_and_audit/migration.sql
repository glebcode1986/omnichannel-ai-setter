-- What the assistant is trying to achieve, and a record of who changed the rules (AI_CONFIGURATION_UX.md,
-- Issue #30).
--
-- Two new settings, and deliberately only two. `AI_CONFIGURATION_UX.md` lists five things under Behavior;
-- three of them already have homes. Escalation/review topics are `mandatory_review_reasons` on this same
-- row, and response guidance and language behaviour are the StyleProfile's — they decide how a reply
-- *sounds*, which is the one thing Style owns and Knowledge and policy must not duplicate. Adding a
-- second place to write tone would guarantee two answers to the same question.
--
-- What is genuinely missing is the goal and the qualification criteria: not how the assistant sounds, but
-- what it is for and when it should consider a lead worth booking.

ALTER TABLE "automation_policies"
  ADD COLUMN "business_goal" TEXT,
  ADD COLUMN "qualification_criteria" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- A criterion is a sentence a person wrote. An empty one is not a criterion, and storing it would show an
-- owner a rule the assistant cannot act on with nothing on screen to explain why.
ALTER TABLE "automation_policies" ADD CONSTRAINT "automation_policies_qualification_check" CHECK (
  NOT ('' = ANY("qualification_criteria"))
);

-- Who changed the rules, when, and what the values were on both sides.
--
-- The spec asks for an audit of *material* policy changes. This records every change that altered a stored
-- value, with the computed impacts alongside — so "material" is a predicate over `impacts` rather than a
-- judgement made at write time and impossible to revisit. A change nobody can see the effect of is a row
-- with an empty `impacts` array, which costs a little space and answers "did anyone touch this?" honestly.
--
-- `actor_user_id` is NOT NULL: a policy change is always somebody's. There is no system path that edits
-- these settings, and if one is ever added it will need its own column rather than a nullable actor that
-- makes every existing row ambiguous.
CREATE TABLE "policy_change_audits" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" TEXT NOT NULL,
  "business_profile_id" TEXT NOT NULL,
  -- NULL when the Business Profile default was edited; set for a channel-account override.
  "channel_account_id" TEXT,
  "actor_user_id" TEXT NOT NULL,
  "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- The impacts `policyImpactsOf` computed for this change. Empty means nothing widened.
  "impacts" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "before" JSONB NOT NULL,
  "after" JSONB NOT NULL,

  CONSTRAINT "policy_change_audits_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "policy_change_audits"
  ADD CONSTRAINT "policy_change_audits_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "policy_change_audits"
  ADD CONSTRAINT "policy_change_audits_business_profile_fkey"
  FOREIGN KEY ("workspace_id", "business_profile_id") REFERENCES "business_profiles"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "policy_change_audits"
  ADD CONSTRAINT "policy_change_audits_actor_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Read as a history: one profile's changes, newest first.
CREATE INDEX "policy_change_audits_history_idx"
  ON "policy_change_audits" ("workspace_id", "business_profile_id", "changed_at" DESC);
