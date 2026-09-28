-- CreateEnum
CREATE TYPE "DeliveryAuthorityKind" AS ENUM ('AUTOMATED', 'HUMAN_APPROVED');

-- AlterTable
ALTER TABLE "delivery_jobs" ADD COLUMN     "approved_at" TIMESTAMP(3),
ADD COLUMN     "decision_key" TEXT,
ADD COLUMN     "approved_by_user_id" TEXT,
ADD COLUMN     "approved_review_mode" "ReviewMode",
ADD COLUMN     "authority" "DeliveryAuthorityKind" NOT NULL DEFAULT 'AUTOMATED';

-- AddForeignKey
ALTER TABLE "delivery_jobs" ADD CONSTRAINT "delivery_jobs_approved_by_user_id_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- An authority is either automation, naming nobody, or a human approval that names everything it needs:
-- the person, the moment, and which send was authorized. A half-recorded approval would be an authority
-- the code would have to guess at, and guessing here is how an automated send acquires a human's name.
--
-- The person is a user, always. Only an authenticated human action may grant this authority (ADR-014): a
-- SYSTEM or NATIVE_APP actor is human activity for the purpose of takeover, but neither can look at a
-- draft and decide to send it. The database is the last place that can still say so.
ALTER TABLE "delivery_jobs" ADD CONSTRAINT "delivery_jobs_authority_check" CHECK (
  (
    "authority" = 'AUTOMATED'
    AND "approved_by_user_id" IS NULL AND "approved_at" IS NULL AND "approved_review_mode" IS NULL
    AND "decision_key" IS NULL
  )
  OR (
    "authority" = 'HUMAN_APPROVED'
    AND "approved_by_user_id" IS NOT NULL AND "approved_at" IS NOT NULL AND "approved_review_mode" IS NOT NULL
    AND "decision_key" IS NOT NULL
  )
);
