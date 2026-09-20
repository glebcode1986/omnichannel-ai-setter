/**
 * The product-level numbers an operator needs during an incident (Issue #56).
 *
 * Every one of these is a count of something a person can act on, read from the durable state rather than
 * from a counter a process keeps in memory: a metric that resets when the worker restarts is worst
 * exactly when the worker has been restarting.
 *
 * They are deliberately not per-tenant. This is the platform's operational picture; a Business Profile's
 * own view of its Inbox is a different surface with different access rules, and mixing the two is how an
 * operational dashboard ends up leaking one customer's volumes to another.
 */
import type { ReasonCode } from "@omnichannel/domain";

import type { DbClient } from "./client";

/**
 * What the draft engine writes when a generation cannot be used (`generate-draft.ts`).
 *
 * The `AiDraftStatus.FAILED` value is not one of them and is never written: an unusable generation is
 * still held, with the reason recorded, because the audit row of what was attempted is worth keeping.
 * A metric built on `FAILED` would have been permanently zero.
 */
const UNUSABLE_GENERATION_REASONS = ["INVALID_MODEL_OUTPUT", "UNSUPPORTED_CONTENT"] as const satisfies readonly ReasonCode[];

export interface ReliabilitySnapshot {
  readonly at: Date;
  /** Webhook events accepted but never processed. A webhook that vanished is silent data loss. */
  readonly unprocessedInboundEvents: number;
  /** Outbox entries still waiting, and how long the oldest has waited — the queue's own backlog. */
  readonly outboxPending: number;
  readonly outboxOldestMs: number;
  /**
   * Generations the model produced but nothing could use — a refusal, or output that failed validation
   * even after repair.
   *
   * This is deliberately *not* "AI errors". A provider that never answers leaves no draft row at all:
   * the generation job fails and is retried, and that shows up as an incident rather than as a count
   * here. Counting only what reached the database and counting it accurately is better than a number
   * that looks like total provider health and silently is not.
   */
  readonly unusableGenerations: number;
  /** Sends whose outcome is unknown, and those that a person now has to decide about. */
  readonly ambiguousOperations: number;
  readonly reconciliationsNeedingHuman: number;
  /** Work waiting on a human, and work stuck mid-send. Both are "nothing is moving" in different ways. */
  readonly draftsAwaitingReview: number;
  readonly deliveriesSending: number;
  /** How overdue the most overdue scheduled delivery is; 0 when nothing is late. */
  readonly oldestOverdueDeliveryMs: number;
}

export interface SnapshotWindow {
  /** How long an inbound event may stay unprocessed before it counts as a failure. */
  readonly unprocessedAfterMs: number;
  /** How far back unusable generations are counted. */
  readonly failureWindowMs: number;
}

export const DEFAULT_SNAPSHOT_WINDOW: SnapshotWindow = {
  // Generous: ingestion dispatches right after commit, so anything still unprocessed after this was not
  // merely slow. Short enough that a broken deploy is visible within one look at the dashboard.
  unprocessedAfterMs: 5 * 60 * 1000,
  failureWindowMs: 60 * 60 * 1000,
};

export async function readReliabilitySnapshot(
  db: DbClient,
  now: Date,
  window: SnapshotWindow = DEFAULT_SNAPSHOT_WINDOW,
): Promise<ReliabilitySnapshot> {
  const unprocessedBefore = new Date(now.getTime() - window.unprocessedAfterMs);
  const failuresAfter = new Date(now.getTime() - window.failureWindowMs);

  const [unprocessedInboundEvents, outboxPending, oldestOutbox, unusableGenerations, ambiguousOperations, reconciliationsNeedingHuman, draftsAwaitingReview, deliveriesSending, oldestOverdue] =
    await Promise.all([
      db.inboundEvent.count({ where: { processedAt: null, receivedAt: { lt: unprocessedBefore } } }),
      db.queueOutbox.count({ where: { dispatchedAt: null } }),
      db.queueOutbox.findFirst({ where: { dispatchedAt: null }, select: { createdAt: true }, orderBy: { createdAt: "asc" } }),
      db.aiDraft.count({ where: { status: "HELD", reasonCodes: { hasSome: [...UNUSABLE_GENERATION_REASONS] }, updatedAt: { gte: failuresAfter } } }),
      db.deliveryJobRecord.count({ where: { status: "HELD_AMBIGUOUS" } }),
      db.deliveryReconciliation.count({ where: { state: "NEEDS_HUMAN" } }),
      db.aiDraft.count({ where: { status: "HELD", needsReview: true } }),
      db.deliveryJobRecord.count({ where: { status: "SENDING" } }),
      db.deliveryJobRecord.findFirst({
        where: { status: "SCHEDULED", scheduledFor: { lt: now } },
        select: { scheduledFor: true },
        orderBy: { scheduledFor: "asc" },
      }),
    ]);

  return {
    at: now,
    unprocessedInboundEvents,
    outboxPending,
    outboxOldestMs: oldestOutbox === null ? 0 : Math.max(0, now.getTime() - oldestOutbox.createdAt.getTime()),
    unusableGenerations,
    ambiguousOperations,
    reconciliationsNeedingHuman,
    draftsAwaitingReview,
    deliveriesSending,
    oldestOverdueDeliveryMs: oldestOverdue === null ? 0 : Math.max(0, now.getTime() - oldestOverdue.scheduledFor.getTime()),
  };
}

/**
 * Generations the provider answered badly, since a moment.
 *
 * Shared by the metrics snapshot and the provider health probe so the dashboard number and the health
 * line can never disagree about what "the model is struggling" means.
 */
export function countUnusableGenerations(db: DbClient, since: Date): Promise<number> {
  return db.aiDraft.count({ where: { status: "HELD", reasonCodes: { hasSome: [...UNUSABLE_GENERATION_REASONS] }, updatedAt: { gte: since } } });
}
