-- Deletion requests, and the durable record of what they removed (#57).
--
-- A deletion is a promise with a deadline, so it is a row rather than a function call: a process that
-- crashes mid-way must leave evidence of how far it got, an operator must be able to answer "was this
-- done, and when", and a partial failure must be visible rather than retried into silence.
CREATE TYPE "DeletionScope" AS ENUM ('CONTACT', 'CONVERSATION', 'BUSINESS_PROFILE', 'WORKSPACE');
CREATE TYPE "DeletionState" AS ENUM ('REQUESTED', 'PROCESSING', 'COMPLETED', 'PARTIAL_FAILURE');

CREATE TABLE "deletion_requests" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "business_profile_id" TEXT,
    "scope" "DeletionScope" NOT NULL,
    "target_id" TEXT,
    "state" "DeletionState" NOT NULL DEFAULT 'REQUESTED',
    "requested_by_user_id" TEXT NOT NULL,
    "reason" TEXT,
    "removed" JSONB NOT NULL DEFAULT '{}',
    "failures" JSONB NOT NULL DEFAULT '[]',
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deletion_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "deletion_requests_workspace_id_state_requested_at_idx" ON "deletion_requests"("workspace_id", "state", "requested_at");
CREATE UNIQUE INDEX "deletion_requests_workspace_id_id_key" ON "deletion_requests"("workspace_id", "id");

ALTER TABLE "deletion_requests" ADD CONSTRAINT "deletion_requests_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "deletion_requests" ADD CONSTRAINT "deletion_requests_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A scope names exactly what it covers, and the shape says which. A CONTACT or CONVERSATION request
-- without a target would be a request nobody could act on; a WORKSPACE request with one would be a
-- narrower deletion wearing the widest scope's name.
ALTER TABLE "deletion_requests" ADD CONSTRAINT "deletion_requests_scope_target_check" CHECK (
  ("scope" IN ('CONTACT', 'CONVERSATION') AND "target_id" IS NOT NULL AND "business_profile_id" IS NOT NULL)
  OR ("scope" = 'BUSINESS_PROFILE' AND "target_id" IS NULL AND "business_profile_id" IS NOT NULL)
  OR ("scope" = 'WORKSPACE' AND "target_id" IS NULL AND "business_profile_id" IS NULL)
);

-- The clock follows the state machine: work that has not begun has no start, and work that has not
-- reached a terminal state has no end. Without this a row can claim to be running and finished at once,
-- and the question "is this still going?" stops having an answer.
ALTER TABLE "deletion_requests" ADD CONSTRAINT "deletion_requests_lifecycle_check" CHECK (
  ("state" = 'REQUESTED' AND "started_at" IS NULL AND "completed_at" IS NULL)
  OR ("state" = 'PROCESSING' AND "started_at" IS NOT NULL AND "completed_at" IS NULL)
  OR ("state" IN ('COMPLETED', 'PARTIAL_FAILURE') AND "started_at" IS NOT NULL AND "completed_at" IS NOT NULL)
);

ALTER TABLE "deletion_requests" ADD CONSTRAINT "deletion_requests_clock_check" CHECK (
  ("started_at" IS NULL OR "started_at" >= "requested_at")
  AND ("completed_at" IS NULL OR "completed_at" >= "started_at")
);

-- A completed deletion removed everything it set out to; one that recorded a failure did not. Tying the
-- two together is what stops "COMPLETED" from being written over a run that gave up half way.
ALTER TABLE "deletion_requests" ADD CONSTRAINT "deletion_requests_failures_check" CHECK (
  ("state" <> 'COMPLETED' OR "failures" = '[]'::jsonb)
  AND ("state" <> 'PARTIAL_FAILURE' OR "failures" <> '[]'::jsonb)
);
