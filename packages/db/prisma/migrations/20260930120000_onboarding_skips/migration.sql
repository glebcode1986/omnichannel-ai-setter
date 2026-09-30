-- A person's decision to pass over an optional setup step (ONBOARDING_UX.md, Issue #27).
--
-- The only part of onboarding that is stored. Every other step's completion is read from the
-- configuration it produced -- the channel account, the policy row, the knowledge documents, the style
-- profile -- so there is no second copy of progress that could drift from what is actually configured.
--
-- A deliberate skip is the one fact the data cannot reveal on its own: "no style yet" and "we decided not
-- to write one" look identical in a style table, and only one of them should let a workspace go live.
--
-- Who skipped is recorded because a skip is an operational decision, and after a bad launch the question
-- is always who decided to leave something out.

-- CreateEnum
CREATE TYPE "OnboardingStep" AS ENUM ('WORKSPACE', 'CHANNELS', 'AI_BEHAVIOUR', 'KNOWLEDGE', 'STYLE', 'TIMING_AND_HANDOFF', 'CHANNEL_POLICY', 'TEST_DRIVE', 'ACTIVATION');

-- CreateTable
CREATE TABLE "onboarding_skips" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "business_profile_id" TEXT NOT NULL,
    "step" "OnboardingStep" NOT NULL,
    "skipped_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "onboarding_skips_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "onboarding_skips_workspace_id_business_profile_id_idx" ON "onboarding_skips"("workspace_id", "business_profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_skips_workspace_id_business_profile_id_step_key" ON "onboarding_skips"("workspace_id", "business_profile_id", "step");

-- AddForeignKey
ALTER TABLE "onboarding_skips" ADD CONSTRAINT "onboarding_skips_workspace_id_business_profile_id_fkey" FOREIGN KEY ("workspace_id", "business_profile_id") REFERENCES "business_profiles"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "onboarding_skips" ADD CONSTRAINT "onboarding_skips_skipped_by_user_id_fkey" FOREIGN KEY ("skipped_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Only genuinely optional steps may be stored as skipped. The domain ignores a skip it does not consider
-- legitimate, but a row asserting that knowledge or activation was "skipped" should not exist at all: it
-- would be a claim that a setter may answer customers with no facts.
ALTER TABLE "onboarding_skips"
    ADD CONSTRAINT "onboarding_skips_skippable_check" CHECK ("step" IN ('STYLE', 'TIMING_AND_HANDOFF', 'TEST_DRIVE'));
