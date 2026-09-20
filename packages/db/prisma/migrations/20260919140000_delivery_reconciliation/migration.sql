-- Reconciliation state for outbound operations whose outcome is unknown (ADR-012, Issue #56).
--
-- The queue is not the record. A Redis flush, an evicted job or a worker that dies mid-reconciliation must
-- not be able to make "we do not know whether the customer received this" disappear, so the row is written
-- before anything is examined and outlives every job that refers to it.
--
-- There is deliberately no column that could hold a resend: recovery is reconcile -> revalidate -> resume
-- through the delivery coordinator, never a replay from here.

CREATE TYPE "ReconciliationReason" AS ENUM ('AMBIGUOUS_SEND_RESULT', 'DELIVERY_HANDLER_FAILED', 'DELIVERY_STALLED');
CREATE TYPE "ReconciliationState" AS ENUM ('PENDING', 'RESOLVED_SENT', 'RESOLVED_RESUMED', 'NEEDS_HUMAN', 'ALREADY_SETTLED');

CREATE TABLE "delivery_reconciliations" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "business_profile_id" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "delivery_job_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "reason" "ReconciliationReason" NOT NULL,
    "state" "ReconciliationState" NOT NULL DEFAULT 'PENDING',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "detected_at" TIMESTAMP(3) NOT NULL,
    "last_attempt_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "evidence" TEXT,
    "provider_request_id" TEXT,
    "provider_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_reconciliations_pkey" PRIMARY KEY ("id")
);

-- One record per logical operation. This is what makes re-delivery of the same reconciliation job
-- idempotent: a second attempt updates the row it already has rather than opening a second investigation.
CREATE UNIQUE INDEX "delivery_reconciliations_operation_id_key" ON "delivery_reconciliations"("operation_id");
CREATE INDEX "delivery_reconciliations_state_detected_at_idx" ON "delivery_reconciliations"("state", "detected_at");
CREATE INDEX "delivery_reconciliations_workspace_id_business_profile_id_s_idx" ON "delivery_reconciliations"("workspace_id", "business_profile_id", "state");

-- Keyed on the operation, so the record and the job it investigates cannot drift apart. RESTRICT rather
-- than CASCADE: an audit record about a send whose outcome was once unknown must not disappear because
-- someone tidied up the delivery row.
ALTER TABLE "delivery_reconciliations"
  ADD CONSTRAINT "delivery_reconciliations_operation_id_fkey"
  FOREIGN KEY ("operation_id") REFERENCES "delivery_jobs"("operation_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A resolution has a moment, and a moment means it is resolved. Half of that pair is a row nobody can
-- read: "resolved, but we do not know when" and "unresolved, resolved at 14:03" are both nonsense, and
-- this table is one an operator will query during an incident.
ALTER TABLE "delivery_reconciliations" ADD CONSTRAINT "delivery_reconciliations_resolved_check" CHECK (
  ("state" IN ('PENDING') AND "resolved_at" IS NULL)
  OR ("state" NOT IN ('PENDING') AND "resolved_at" IS NOT NULL)
);

-- An attempt count that never moved means nothing has examined this operation, which cannot be true of a
-- row that has already concluded something.
ALTER TABLE "delivery_reconciliations" ADD CONSTRAINT "delivery_reconciliations_attempt_check" CHECK (
  "attempt_count" >= 0 AND ("state" = 'PENDING' OR "attempt_count" > 0)
);
