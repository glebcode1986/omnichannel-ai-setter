-- CreateEnum
CREATE TYPE "UsageEventKind" AS ENUM ('RECORD', 'RESERVE', 'COMMIT', 'RELEASE');

-- CreateEnum
CREATE TYPE "UsageReservationState" AS ENUM ('RESERVED', 'COMMITTED', 'RELEASED');

-- CreateEnum
CREATE TYPE "UsageMetricKind" AS ENUM ('VOICE_TRANSCRIPTION_SECONDS', 'AI_GENERATION_CYCLES', 'SIMULATION_GENERATION_CYCLES');

-- CreateTable
CREATE TABLE "usage_cycles" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "anchor_day" INTEGER NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_cycles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_ledger_entries" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "cycle_id" TEXT NOT NULL,
    "metric" "UsageMetricKind" NOT NULL,
    "kind" "UsageEventKind" NOT NULL,
    "usage_operation_id" TEXT NOT NULL,
    "committed_delta" INTEGER NOT NULL,
    "reserved_delta" INTEGER NOT NULL,
    "subject_type" TEXT,
    "subject_id" TEXT,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_counters" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "cycle_id" TEXT NOT NULL,
    "metric" "UsageMetricKind" NOT NULL,
    "committed" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usage_counters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_reservations" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "cycle_id" TEXT NOT NULL,
    "metric" "UsageMetricKind" NOT NULL,
    "usage_operation_id" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "state" "UsageReservationState" NOT NULL DEFAULT 'RESERVED',
    "committed_amount" INTEGER,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "settled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "usage_cycles_workspace_id_ends_at_idx" ON "usage_cycles"("workspace_id", "ends_at");

-- CreateIndex
CREATE UNIQUE INDEX "usage_cycles_workspace_id_starts_at_key" ON "usage_cycles"("workspace_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "usage_cycles_workspace_id_key" ON "usage_cycles"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "usage_ledger_entries_workspace_id_cycle_id_metric_idx" ON "usage_ledger_entries"("workspace_id", "cycle_id", "metric");

-- CreateIndex
CREATE INDEX "usage_ledger_entries_workspace_id_recorded_at_idx" ON "usage_ledger_entries"("workspace_id", "recorded_at");

-- CreateIndex
CREATE UNIQUE INDEX "usage_ledger_operation_key" ON "usage_ledger_entries"("workspace_id", "metric", "usage_operation_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "usage_counters_metric_key" ON "usage_counters"("workspace_id", "cycle_id", "metric");

-- CreateIndex
CREATE INDEX "usage_reservations_state_expires_at_idx" ON "usage_reservations"("state", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "usage_reservations_operation_key" ON "usage_reservations"("workspace_id", "metric", "usage_operation_id");

-- AddForeignKey
ALTER TABLE "usage_cycles" ADD CONSTRAINT "usage_cycles_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "usage_ledger_entries" ADD CONSTRAINT "usage_ledger_entries_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "usage_ledger_entries" ADD CONSTRAINT "usage_ledger_entries_workspace_id_cycle_id_fkey" FOREIGN KEY ("workspace_id", "cycle_id") REFERENCES "usage_cycles"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_workspace_id_cycle_id_fkey" FOREIGN KEY ("workspace_id", "cycle_id") REFERENCES "usage_cycles"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "usage_reservations" ADD CONSTRAINT "usage_reservations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "usage_reservations" ADD CONSTRAINT "usage_reservations_workspace_id_cycle_id_fkey" FOREIGN KEY ("workspace_id", "cycle_id") REFERENCES "usage_cycles"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------------------------------------
-- Invariants Prisma cannot express (#39, USAGE_METERING.md)
-- ---------------------------------------------------------------------------------------------------------

-- A cycle is a period. One that ended before it began, or ended at the same instant, would make
-- "which cycle does this belong to?" unanswerable, and the half-open boundary meaningless.
ALTER TABLE "usage_cycles" ADD CONSTRAINT "usage_cycles_period_check" CHECK ("ends_at" > "starts_at");

-- The anchor is a day of month. Clamping happens in the domain; this refuses a value that could never
-- have come from one.
ALTER TABLE "usage_cycles" ADD CONSTRAINT "usage_cycles_anchor_check" CHECK ("anchor_day" BETWEEN 1 AND 31);

-- (The composite workspace+cycle foreign keys that make tenancy structural are generated from the schema.)

-- Each kind of event moves exactly the counters it is supposed to, and no others. The arithmetic lives in
-- `ledgerDeltas`; this is the same statement made where a hand-written INSERT during a support call also
-- has to obey it.
ALTER TABLE "usage_ledger_entries" ADD CONSTRAINT "usage_ledger_entries_delta_check" CHECK (
  ("kind" = 'RECORD'  AND "committed_delta" > 0 AND "reserved_delta" = 0)
  OR ("kind" = 'RESERVE' AND "committed_delta" = 0 AND "reserved_delta" > 0)
  -- A commit may consume more than it held, and may legitimately consume nothing.
  OR ("kind" = 'COMMIT'  AND "committed_delta" >= 0 AND "reserved_delta" < 0)
  -- A release consumes nothing. That is the whole difference between it and a commit of zero.
  OR ("kind" = 'RELEASE' AND "committed_delta" = 0 AND "reserved_delta" < 0)
);

-- Counters cannot go negative. A double release or a lost hold shows up here as a refused write rather
-- than as an allowance that quietly grew.
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_non_negative_check" CHECK ("committed" >= 0 AND "reserved" >= 0);

-- Only a metric a plan actually sells may be reserved against.
--
-- Maintenance obligation, stated rather than left to be discovered: adding a customer-facing metric means
-- widening this list in the same migration that adds it. The alternative — no constraint — is a
-- reservation against an internal metric that silently succeeds, which is the one outcome worse than a
-- refusal, because the caller then believes an allowance was checked.
ALTER TABLE "usage_reservations" ADD CONSTRAINT "usage_reservations_quota_metric_check" CHECK (
  "metric" IN ('VOICE_TRANSCRIPTION_SECONDS')
);

-- A hold is for a positive amount, and what it settled for is never negative.
ALTER TABLE "usage_reservations" ADD CONSTRAINT "usage_reservations_amount_check" CHECK (
  "amount" > 0 AND ("committed_amount" IS NULL OR "committed_amount" >= 0)
);

-- The state and the settlement columns say one thing, not two. A RESERVED row with a settlement time has
-- had its allowance both held and given back; a COMMITTED row without an amount cannot say what it used.
ALTER TABLE "usage_reservations" ADD CONSTRAINT "usage_reservations_state_check" CHECK (
  ("state" = 'RESERVED'  AND "settled_at" IS NULL     AND "committed_amount" IS NULL)
  OR ("state" = 'COMMITTED' AND "settled_at" IS NOT NULL AND "committed_amount" IS NOT NULL)
  OR ("state" = 'RELEASED'  AND "settled_at" IS NOT NULL AND "committed_amount" IS NULL)
);
