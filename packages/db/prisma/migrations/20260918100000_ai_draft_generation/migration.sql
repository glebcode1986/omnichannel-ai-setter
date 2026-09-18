-- AlterTable
ALTER TABLE "ai_drafts" ADD COLUMN     "cache_read_tokens" INTEGER,
ADD COLUMN     "cache_write_tokens" INTEGER,
ADD COLUMN     "generation_key" TEXT NOT NULL,
ADD COLUMN     "input_tokens" INTEGER,
ADD COLUMN     "output_tokens" INTEGER,
ALTER COLUMN "text" DROP NOT NULL,
ALTER COLUMN "structured_output" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "ai_drafts_generation_key" ON "ai_drafts"("workspace_id", "business_profile_id", "generation_key");



-- Hand-written integrity rules (see packages/db constraint tests).
-- A draft may only be missing its text and structured output when it is HELD: that is the audit row for a
-- generation whose output could not be used. Anything a human or the delivery path could act on must be
-- complete.
ALTER TABLE "ai_drafts" ADD CONSTRAINT "ai_drafts_usable_check" CHECK (
  "status" = 'HELD' OR ("text" IS NOT NULL AND "structured_output" IS NOT NULL)
);
-- Usage counters are counts, and a generation key identifies something.
ALTER TABLE "ai_drafts" ADD CONSTRAINT "ai_drafts_usage_check" CHECK (
  ("input_tokens" IS NULL OR "input_tokens" >= 0)
  AND ("output_tokens" IS NULL OR "output_tokens" >= 0)
  AND ("cache_read_tokens" IS NULL OR "cache_read_tokens" >= 0)
  AND ("cache_write_tokens" IS NULL OR "cache_write_tokens" >= 0)
  AND "generation_key" <> ''
);
