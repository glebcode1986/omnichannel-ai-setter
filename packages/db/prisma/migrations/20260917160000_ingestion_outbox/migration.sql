-- CreateEnum
CREATE TYPE "OutboxKind" AS ENUM ('INBOUND_DEBOUNCE');

-- AlterTable
ALTER TABLE "inbound_events" ADD COLUMN     "correlation_id" TEXT,
ADD COLUMN     "outcome" TEXT;

-- CreateTable
CREATE TABLE "queue_outbox" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "business_profile_id" TEXT NOT NULL,
    "kind" "OutboxKind" NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "delay_ms" INTEGER NOT NULL,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_until" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error_name" TEXT,
    "dispatched_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "queue_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "queue_outbox_dedupe_key_key" ON "queue_outbox"("dedupe_key");

-- CreateIndex
CREATE INDEX "queue_outbox_pending_idx" ON "queue_outbox"("available_at") WHERE (dispatched_at IS NULL);

-- AddForeignKey
ALTER TABLE "queue_outbox" ADD CONSTRAINT "queue_outbox_workspace_id_business_profile_id_fkey" FOREIGN KEY ("workspace_id", "business_profile_id") REFERENCES "business_profiles"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Hand-written integrity rules (see packages/db constraint tests).
ALTER TABLE "queue_outbox" ADD CONSTRAINT "queue_outbox_counters_check" CHECK ("delay_ms" >= 0 AND "attempts" >= 0);
