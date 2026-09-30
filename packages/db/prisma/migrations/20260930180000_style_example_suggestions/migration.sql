-- Suggested style examples, and the rule that only a verified one is used (KNOWLEDGE_STYLE_UX.md, #32).
--
-- Until now a style example was either ACTIVE or ARCHIVED, which left no way to record one the *system*
-- noticed. A reply a colleague typed natively from their phone is exactly such a case: it is genuinely
-- human writing and genuinely evidence about how this business sounds, but nobody has said "yes, sound
-- like that". Writing it straight to ACTIVE would let one hurried message start shaping every later
-- reply's tone, which is the quiet version of the failure ADR-011 exists to prevent.
--
-- So SUGGESTED is a real state with no effect on retrieval — the style query already filters
-- `status = 'ACTIVE'`, so a suggestion is inert until somebody activates it — and REJECTED records a
-- decision rather than deleting the evidence of it.

ALTER TYPE "StyleExampleStatus" ADD VALUE IF NOT EXISTS 'SUGGESTED';
ALTER TYPE "StyleExampleStatus" ADD VALUE IF NOT EXISTS 'REJECTED';

-- The invariant, where it cannot be forgotten: an example in use was approved by a person, and the row
-- says which person. "Verified" with nobody's name on it is not verified, it is unattributed.
--
-- Existing ACTIVE rows written by the internal seeding path had no approver, which is the hole this
-- closes; the seed now records the context's own authenticated user, like every other customer-data write.
UPDATE "style_examples" s
   SET "approved_by_user_id" = (
     SELECT m."user_id"
       FROM "workspace_members" m
      WHERE m."workspace_id" = s."workspace_id"
      ORDER BY CASE WHEN m."role" = 'OWNER' THEN 0 ELSE 1 END, m."created_at"
      LIMIT 1
   )
 WHERE s."status" = 'ACTIVE' AND s."approved_by_user_id" IS NULL;

-- Anything left unattributed after that backfill has no member to attribute it to, so it cannot honestly
-- be called verified. It becomes a suggestion rather than being deleted: the wording is still evidence,
-- it just has to be approved by somebody before it shapes a reply.
UPDATE "style_examples"
   SET "status" = 'SUGGESTED'
 WHERE "status" = 'ACTIVE' AND "approved_by_user_id" IS NULL;

ALTER TABLE "style_examples" ADD CONSTRAINT "style_examples_verified_check" CHECK (
  "status" <> 'ACTIVE' OR "approved_by_user_id" IS NOT NULL
);

-- A suggestion nobody has judged has no approver yet; approving it is what sets one.
CREATE INDEX "style_examples_suggested_idx"
  ON "style_examples" ("workspace_id", "business_profile_id", "status", "created_at" DESC);
