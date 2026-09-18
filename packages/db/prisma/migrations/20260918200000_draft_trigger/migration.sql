-- Who asked for a draft (product-owner decision on PR #65).
--
-- Mode OFF means no background generation, but an authorized person may still ask the assistant for help
-- with the reply they are about to write themselves. The two acts must stay distinguishable in the audit
-- trail, and a request that claims to be human has to name the human — otherwise an inbound-triggered job
-- could later be mistaken for one.

CREATE TYPE "AiDraftTrigger" AS ENUM ('AUTOMATIC', 'HUMAN_REQUEST');

ALTER TABLE "ai_drafts"
  ADD COLUMN "trigger" "AiDraftTrigger" NOT NULL DEFAULT 'AUTOMATIC',
  ADD COLUMN "requested_by_user_id" TEXT;

ALTER TABLE "ai_drafts"
  ADD CONSTRAINT "ai_drafts_requested_by_user_id_fkey"
  FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A human request names its human, and nothing else may. Without this the column is a suggestion: an
-- automatic draft could carry a user id and read, later, as if a person had asked for it.
ALTER TABLE "ai_drafts"
  ADD CONSTRAINT "ai_drafts_human_request_actor_check"
  CHECK (("trigger" = 'HUMAN_REQUEST') = ("requested_by_user_id" IS NOT NULL));

CREATE INDEX "ai_drafts_requested_by_user_id_idx" ON "ai_drafts"("requested_by_user_id");
