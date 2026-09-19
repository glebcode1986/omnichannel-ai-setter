-- The automated-outbound kill switch (RELIABILITY_INCIDENTS.md, Issue #56).
--
-- It stops outbound only. Inbound keeps arriving and keeps being stored: the person pulling this is trying
-- to prevent harm, and a switch that also dropped customer messages would turn a precaution into data loss.
--
-- Lifted switches are kept rather than deleted. The question after an incident is always who turned this
-- off and whether anyone turned it back on, and a deleted row cannot answer either half.

CREATE TYPE "SuspensionScope" AS ENUM ('GLOBAL', 'WORKSPACE', 'BUSINESS_PROFILE', 'CHANNEL_ACCOUNT');
CREATE TYPE "SuspensionReason" AS ENUM ('OPERATOR', 'DEPENDENCY_FAILURE', 'CHANNEL_UNHEALTHY', 'BACKLOG');

CREATE TABLE "automation_suspensions" (
    "id" TEXT NOT NULL,
    "scope" "SuspensionScope" NOT NULL,
    "workspace_id" TEXT,
    "business_profile_id" TEXT,
    "channel_account_id" TEXT,
    "reason" "SuspensionReason" NOT NULL,
    "note" TEXT,
    "since" TIMESTAMP(3) NOT NULL,
    "until" TIMESTAMP(3),
    "by_user_id" TEXT,
    "lifted_at" TIMESTAMP(3),
    "lifted_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_suspensions_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "automation_suspensions"
  ADD CONSTRAINT "automation_suspensions_by_user_id_fkey"
  FOREIGN KEY ("by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "automation_suspensions"
  ADD CONSTRAINT "automation_suspensions_lifted_by_user_id_fkey"
  FOREIGN KEY ("lifted_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A narrow scope must name what it narrows to. Without this a BUSINESS_PROFILE row with no profile named
-- would be a global stop wearing a contained-looking label -- the most dangerous shape this table can take.
ALTER TABLE "automation_suspensions" ADD CONSTRAINT "automation_suspensions_scope_check" CHECK (
  (
    "scope" = 'GLOBAL'
    AND "workspace_id" IS NULL AND "business_profile_id" IS NULL AND "channel_account_id" IS NULL
  )
  OR (
    "scope" = 'WORKSPACE'
    AND "workspace_id" IS NOT NULL AND "business_profile_id" IS NULL AND "channel_account_id" IS NULL
  )
  OR (
    "scope" = 'BUSINESS_PROFILE'
    AND "workspace_id" IS NOT NULL AND "business_profile_id" IS NOT NULL AND "channel_account_id" IS NULL
  )
  OR (
    "scope" = 'CHANNEL_ACCOUNT'
    AND "workspace_id" IS NOT NULL AND "channel_account_id" IS NOT NULL AND "business_profile_id" IS NULL
  )
);

-- An end must come after a beginning; a window that closes before it opens is not a pause.
ALTER TABLE "automation_suspensions" ADD CONSTRAINT "automation_suspensions_window_check"
  CHECK ("until" IS NULL OR "until" > "since");

-- Lifting records both the moment and the person, or neither.
ALTER TABLE "automation_suspensions" ADD CONSTRAINT "automation_suspensions_lifted_check"
  CHECK (("lifted_at" IS NULL) = ("lifted_by_user_id" IS NULL));

CREATE INDEX "automation_suspensions_scope_lifted_at_idx" ON "automation_suspensions"("scope", "lifted_at");
CREATE INDEX "automation_suspensions_workspace_id_business_profile_id_lif_idx"
  ON "automation_suspensions"("workspace_id", "business_profile_id", "lifted_at");
