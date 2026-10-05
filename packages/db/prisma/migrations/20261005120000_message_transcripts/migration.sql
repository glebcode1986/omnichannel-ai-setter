-- CreateEnum
CREATE TYPE "TranscriptionState" AS ENUM ('PENDING', 'READY', 'FAILED', 'UNSUPPORTED');

-- AlterEnum
ALTER TYPE "OutboxKind" ADD VALUE 'MEDIA_TRANSCRIPTION';

-- CreateTable
CREATE TABLE "message_transcripts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "business_profile_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "provider_media_id" TEXT NOT NULL,
    "mime_type" TEXT,
    "size_bytes" INTEGER,
    "state" "TranscriptionState" NOT NULL DEFAULT 'PENDING',
    "text" TEXT,
    "language" TEXT,
    "provider" TEXT,
    "model" TEXT,
    "model_revision" TEXT,
    "confidence" DOUBLE PRECISION,
    "confidence_source" TEXT,
    "duration_seconds" DOUBLE PRECISION,
    "provider_request_id" TEXT,
    "latency_ms" INTEGER,
    "failure_reason" TEXT,
    "failure_code" TEXT,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "media_deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "message_transcripts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "message_transcripts_workspace_id_state_idx" ON "message_transcripts"("workspace_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "message_transcripts_workspace_id_message_id_provider_media__key" ON "message_transcripts"("workspace_id", "message_id", "provider_media_id");

-- CreateIndex
CREATE UNIQUE INDEX "message_transcripts_workspace_id_id_key" ON "message_transcripts"("workspace_id", "id");

-- AddForeignKey
ALTER TABLE "message_transcripts" ADD CONSTRAINT "message_transcripts_workspace_id_business_profile_id_messa_fkey" FOREIGN KEY ("workspace_id", "business_profile_id", "message_id") REFERENCES "messages"("workspace_id", "business_profile_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- A reading that succeeded has words, and a reading that did not has none. Both halves matter: a READY
-- row with no text is a transcript nothing can be drafted from, and a FAILED row carrying text is how a
-- half-written reading would reach a customer's reply as though it had worked (Issue #21).
ALTER TABLE "message_transcripts" ADD CONSTRAINT "message_transcripts_ready_has_text_check" CHECK (
  "state" <> 'READY'
  OR ("text" IS NOT NULL AND btrim("text") <> '' AND "provider" IS NOT NULL AND "model" IS NOT NULL)
);

ALTER TABLE "message_transcripts" ADD CONSTRAINT "message_transcripts_unready_has_no_text_check" CHECK (
  "state" = 'READY' OR "text" IS NULL
);

-- A failure nobody can name is a failure nobody can act on, and the review item it produces would say
-- nothing. The vocabulary is this codebase's own; the provider's prose can quote the recording.
ALTER TABLE "message_transcripts" ADD CONSTRAINT "message_transcripts_failure_named_check" CHECK (
  "state" NOT IN ('FAILED', 'UNSUPPORTED') OR "failure_reason" IS NOT NULL
);

-- No unattributed certainty. The recommended model publishes no confidence at all, so this column is
-- expected to be null — and if a number ever lands here it must say where it came from, because a figure
-- with no source is indistinguishable from one somebody invented.
ALTER TABLE "message_transcripts" ADD CONSTRAINT "message_transcripts_confidence_attributed_check" CHECK (
  ("confidence" IS NULL) = ("confidence_source" IS NULL)
);

ALTER TABLE "message_transcripts" ADD CONSTRAINT "message_transcripts_confidence_range_check" CHECK (
  "confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1)
);

ALTER TABLE "message_transcripts" ADD CONSTRAINT "message_transcripts_confidence_source_check" CHECK (
  "confidence_source" IS NULL OR "confidence_source" IN ('PROVIDER', 'DERIVED')
);

-- Measurements move forward and cannot be negative: a recording of minus four seconds, a reading that
-- took minus a millisecond, or a row that has been attempted a negative number of times are all rows a
-- later reader would try to reason about.
ALTER TABLE "message_transcripts" ADD CONSTRAINT "message_transcripts_measurements_check" CHECK (
  "attempt_count" >= 0
  AND ("duration_seconds" IS NULL OR "duration_seconds" > 0)
  AND ("latency_ms" IS NULL OR "latency_ms" >= 0)
  AND ("size_bytes" IS NULL OR "size_bytes" > 0)
  AND ("completed_at" IS NULL OR "completed_at" >= "requested_at")
);

-- A pending reading has not finished, and a finished one has. Without this, a row can claim both at once
-- and the sweeper that looks for work has no way to tell which rows are still owed an answer.
ALTER TABLE "message_transcripts" ADD CONSTRAINT "message_transcripts_pending_unfinished_check" CHECK (
  ("state" = 'PENDING') = ("completed_at" IS NULL)
);
