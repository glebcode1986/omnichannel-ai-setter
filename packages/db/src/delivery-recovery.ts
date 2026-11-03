/**
 * Finding replies that were approved and never queued, and queueing them (Issue #125).
 *
 * This exists because the bridge it repairs was missing for the whole life of the feature. Every reply a
 * person approved or wrote before `addDeliveryDispatchEntry` landed committed a `delivery_jobs` row with
 * `status = 'SCHEDULED'` and no queue job, and nothing recovered those rows: the reconciliation sweep's
 * selection takes `HELD_AMBIGUOUS` only. Fixing the write path alone would leave them stranded for good —
 * and, worse, each one keeps blocking its conversation, because `composer-store` reads a `SCHEDULED` row
 * as "a reply is already in flight".
 *
 * **Why this is safe to run repeatedly, which is the only property that matters here.** It never sends
 * anything; it writes an outbox entry, and the entry's `dedupe_key` is `UNIQUE` on `operationId`. So the
 * second run of this sweep over the same row adds nothing, and a row that the write path has already
 * covered is skipped by the same uniqueness. There is no "has it been recovered yet" flag to get wrong.
 *
 * **What it refuses to touch, and why each exclusion is load-bearing:**
 *
 * - anything that is not `SCHEDULED`. A `SENDING` row is in flight, `HELD_AMBIGUOUS` is the case where
 *   nobody knows whether the customer received it, and ADR-012 is explicit that an ambiguous outcome is
 *   quarantined and never blindly resent. Recovery here means "this definitely never left", and the
 *   status is the only thing that can say so.
 * - anything with a `delivery_reconciliations` row. Belt and braces over the status filter: an operation
 *   under investigation belongs to that investigation, whatever its row says this instant.
 * - anything younger than `graceMs`. Not for correctness — the entry and the row commit together, so
 *   there is no window — but so that a backlog in the dispatcher is never mistaken for a stranded row.
 *   Without it, a sweep running while the dispatcher is briefly behind would churn through healthy work.
 *
 * It is bounded by `limit` and reports what it found, so a large backlog drains over several runs instead
 * of one transaction holding thousands of rows.
 */
import type { DbClient, DbExecutor } from "./client";
import { recordSystemAuditEvent } from "./audit-store";
import { addDeliveryDispatchEntry, deliveryDispatchDedupeKey } from "./delivery-dispatch";

/** How long a `SCHEDULED` row is left alone before it counts as stranded. */
export const DELIVERY_RECOVERY_GRACE_MS = 60_000;

export interface DeliveryRecoveryResult {
  /** Rows that looked stranded and were not already covered by an outbox entry. */
  readonly stranded: number;
  /** Entries this run actually added. Lower than `stranded` when a concurrent run won the insert. */
  readonly recovered: number;
  /**
   * Candidate rows examined.
   *
   * Reported so a saturated scan is visible. `scanned` at the cap with `stranded: 0` means the window was
   * full of healthy rows and a stranded one may be behind them — which is a dispatcher problem, not a
   * recovery one, and silence would hide it.
   */
  readonly scanned: number;
}

export interface DeliveryRecoveryOptions {
  readonly now: Date;
  /** How many repairs one run may make. */
  readonly limit?: number;
  /** How many candidate rows one run may examine to find them. Defaults to ten times `limit`. */
  readonly scanLimit?: number;
  readonly graceMs?: number;
}

const DEFAULT_LIMIT = 100;
const SCAN_FACTOR = 10;
const MAX_SCAN = 1_000;

/**
 * One sweep.
 *
 * Reads candidates outside a transaction and writes each repair in its own, rather than holding one
 * transaction over the whole batch: a single long transaction would block the write path it is repairing,
 * and a failure in the hundredth row would roll back the ninety-nine repairs that worked.
 */
export async function recoverStrandedDeliveries(
  db: DbClient,
  options: DeliveryRecoveryOptions,
): Promise<DeliveryRecoveryResult> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const scanLimit = Math.min(options.scanLimit ?? limit * SCAN_FACTOR, MAX_SCAN);
  const graceMs = options.graceMs ?? DELIVERY_RECOVERY_GRACE_MS;
  const before = new Date(options.now.getTime() - graceMs);

  const candidates = await db.deliveryJobRecord.findMany({
    where: {
      status: "SCHEDULED",
      scheduledFor: { lte: before },
      // An operation under investigation is that investigation's business, not this sweep's.
      reconciliation: { is: null },
    },
    select: {
      id: true,
      workspaceId: true,
      businessProfileId: true,
      operationId: true,
      correlationId: true,
      draftId: true,
      conversationId: true,
      scheduledFor: true,
      selectedDelayMs: true,
      // Both origins, because `conversationId` is null for an AI draft and the draft holds it instead
      // (ADR-018 Option B). Selecting only the direct column would recover a human-composed reply and
      // silently skip every approved draft — the larger half.
      draft: { select: { conversationId: true } },
    },
    // Stable, because `scheduledFor` ties are normal — a batch of approvals shares an instant — and an
    // unstable order makes which rows a scan sees depend on the planner.
    orderBy: [{ scheduledFor: "asc" }, { id: "asc" }],
    // Deliberately wider than `limit`. A row that already has its entry is *healthy*, and healthy rows
    // sit in this window too, so scanning exactly `limit` rows and then discarding the covered ones lets
    // covered rows at the front starve the stranded ones behind them — the sweep would report nothing to
    // do while the thing it exists for sat one row further down. Measured: three stranded rows with
    // `limit: 2` recovered two and then found "nothing", forever.
    take: scanLimit,
  });
  if (candidates.length === 0) {
    return { stranded: 0, recovered: 0, scanned: 0 };
  }

  // One query for the whole batch rather than a correlated NOT EXISTS, because the dedupe key is computed
  // in TypeScript and PostgreSQL cannot join on a value it has never seen.
  const keys = candidates.map((row) => deliveryDispatchDedupeKey(row));
  const existing = await db.queueOutbox.findMany({
    where: { kind: "DELIVERY_DISPATCH", dedupeKey: { in: keys } },
    select: { dedupeKey: true },
  });
  const covered = new Set(existing.map((row) => row.dedupeKey));
  // `limit` applies to repairs, `scanLimit` to the looking. Separating them is what stops healthy rows at
  // the front of the window from starving the stranded ones behind them.
  const stranded = candidates.filter((row) => !covered.has(deliveryDispatchDedupeKey(row))).slice(0, limit);
  if (stranded.length === 0) {
    return { stranded: 0, recovered: 0, scanned: candidates.length };
  }

  let recovered = 0;
  for (const row of stranded) {
    const conversationId = row.conversationId ?? row.draft?.conversationId;
    if (conversationId === undefined || conversationId === null) {
      // A row satisfying neither origin would violate `delivery_jobs_one_origin_check`, so reaching here
      // means the CHECK is gone. Skipped rather than guessed at: a delivery whose conversation nobody can
      // name must not be given one.
      continue;
    }
    const added = await db.$transaction(async (tx: DbExecutor) => {
      const inserted = await addDeliveryDispatchEntry(tx, {
        workspaceId: row.workspaceId,
        businessProfileId: row.businessProfileId,
        conversationId,
        ...(row.draftId === null ? {} : { draftId: row.draftId }),
        deliveryJobId: row.id,
        operationId: row.operationId,
        correlationId: row.correlationId,
        scheduledFor: row.scheduledFor,
        selectedDelayMs: row.selectedDelayMs,
      });
      if (!inserted) {
        // Another run inserted it between the read and this write. Nothing to record: the repair happened,
        // it just was not this run's, and an audit row per loser of that race would be noise.
        return false;
      }
      await recordSystemAuditEvent(
        tx,
        { workspaceId: row.workspaceId, businessProfileId: row.businessProfileId },
        {
          kind: "DELIVERY_DISPATCH_RECOVERED",
          subjectType: "DeliveryJobRecord",
          subjectId: row.id,
          // Written in the words somebody searching an incident would use, which is what `summary` is for.
          summary: "An approved reply had never been queued and was handed to the delivery queue",
          conversationId,
          detail: {
            operationId: row.operationId,
            scheduledFor: row.scheduledFor.toISOString(),
            strandedForMs: options.now.getTime() - row.scheduledFor.getTime(),
            origin: row.draftId === null ? "HUMAN_COMPOSED" : "AI_DRAFT",
          },
        },
      );
      return true;
    });
    if (added) {
      recovered += 1;
    }
  }

  return { stranded: stranded.length, recovered, scanned: candidates.length };
}
