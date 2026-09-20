/**
 * Why one outbound operation's outcome is unknown (ADR-012).
 *
 * This list lives in the domain rather than in the queue package because it is not a property of BullMQ.
 * It is the vocabulary the coordinator, the queue and the reconciliation consumer all have to agree on,
 * and a second copy of it in an infrastructure package is how two layers end up disagreeing about what
 * "ambiguous" meant.
 */
import { literalGuard } from "./enum";

export const RECONCILIATION_REASONS = [
  /** The adapter reported AMBIGUOUS: the request may have reached the platform. */
  "AMBIGUOUS_SEND_RESULT",
  /** The delivery handler threw or returned an unreadable result, so whether a send happened is unknown. */
  "DELIVERY_HANDLER_FAILED",
  /** The worker running the delivery died or lost its lock mid-run; the job is failed, never re-run. */
  "DELIVERY_STALLED",
] as const;
export type ReconciliationReason = (typeof RECONCILIATION_REASONS)[number];
export const isReconciliationReason = literalGuard(RECONCILIATION_REASONS);
