/**
 * Counting what a workspace consumes (#39, USAGE_METERING.md, ADR-017).
 *
 * Two kinds of counting live here, and keeping them apart is the file's main job.
 *
 * An **internal metric** exists for unit economics, fair-use and abuse detection, anomaly alerting and
 * capacity planning. It can never refuse work. A **customer-facing quota** is an allowance a plan sells,
 * and running out of it stops the thing it pays for.
 *
 * Core AI reply generation is included and unmetered in the initial public plans, and
 * `AI_GENERATION_CYCLES` being internal is how the code states that rather than merely documenting it:
 * there is no path through which an exhausted AI allowance could hold a reply, because no such allowance
 * exists. `reserve` against an internal metric is refused outright, because a reservation that quietly
 * succeeded would leave its caller believing it had checked something.
 *
 * Nothing here reads a clock, a database or a provider. A cycle boundary and a reservation decision are
 * both arithmetic, and arithmetic that cannot be tested in isolation is arithmetic nobody trusts.
 */
import { literalGuard } from "./enum";
import { DomainValidationError } from "./errors";
import { USAGE_METRICS, type EntitlementSnapshot, type UsageMetric } from "./entitlements";

/**
 * Metrics counted for ourselves, never sold.
 *
 * `AI_GENERATION_CYCLES` is one logical reply generation — not one provider call. A provider retry, a
 * schema repair and a requeued job are the same cycle, which is the whole reason the ledger is keyed on a
 * logical operation identity instead of on attempts.
 *
 * `SIMULATION_GENERATION_CYCLES` is the no-send playground. Counted because it costs the same money as a
 * real generation and a scripted loop through it would otherwise be invisible.
 */
export const INTERNAL_USAGE_METRICS = ["AI_GENERATION_CYCLES", "SIMULATION_GENERATION_CYCLES"] as const;
export type InternalUsageMetric = (typeof INTERNAL_USAGE_METRICS)[number];
export const isInternalUsageMetric = literalGuard(INTERNAL_USAGE_METRICS);

/** Everything the ledger may record, sold or not. */
export const LEDGER_METRICS = [...USAGE_METRICS, ...INTERNAL_USAGE_METRICS] as const;
export type LedgerMetric = UsageMetric | InternalUsageMetric;
export const isLedgerMetric = literalGuard(LEDGER_METRICS);

/**
 * Whether this metric is an allowance a plan sells.
 *
 * The single place that decides. Both the reservation path and the store's refusals consult it, so a
 * metric cannot be internal in one file and billable in another — and adding a metric to the wrong list
 * fails loudly at the first reservation rather than quietly changing what the product charges for.
 */
export function hasCustomerQuota(metric: LedgerMetric): metric is UsageMetric {
  return (USAGE_METRICS as readonly string[]).includes(metric);
}

/** What a ledger row is a record of. Append-only: a correction is another row, never an edit. */
export const USAGE_EVENT_KINDS = ["RECORD", "RESERVE", "COMMIT", "RELEASE"] as const;
export type UsageEventKind = (typeof USAGE_EVENT_KINDS)[number];
export const isUsageEventKind = literalGuard(USAGE_EVENT_KINDS);

/** A reservation's life. `RESERVED` is the only state that still holds allowance. */
export const RESERVATION_STATES = ["RESERVED", "COMMITTED", "RELEASED"] as const;
export type ReservationState = (typeof RESERVATION_STATES)[number];
export const isReservationState = literalGuard(RESERVATION_STATES);

/** A period with authoritative boundaries, half-open so two cycles can neither overlap nor leave a gap. */
export interface UsageCycleBounds {
  readonly startsAt: Date;
  /** Exclusive. An operation at exactly this instant belongs to the next cycle. */
  readonly endsAt: Date;
  /** The day of month the subscription is anchored on, remembered rather than clamped. */
  readonly anchorDay: number;
}

const MAX_ANCHOR_DAY = 31;

/**
 * The cycle containing `at`, for a subscription anchored on `anchorDay`.
 *
 * The anchor is remembered, not rewritten. A 31st anchor lands on the 28th in February and on the 31st
 * again in March, because a cycle that permanently moved to the shortest month it met would shorten every
 * later month by three days — and a business would lose three days of allowance a year to a rounding
 * decision nobody made.
 *
 * Half-open on purpose: `startsAt` is inclusive and `endsAt` is not, so consecutive cycles tile the
 * timeline exactly. Ledger rows cannot fall between two cycles, and cannot belong to both.
 *
 * All arithmetic is UTC. A cycle boundary that moved with daylight saving would make one month 23 hours
 * longer than its neighbour, and the boundary is a billing fact rather than a local-time convenience.
 */
export function usageCycleFor(anchorDay: number, at: Date): UsageCycleBounds {
  const anchor = Math.trunc(anchorDay);
  if (!Number.isFinite(anchor) || anchor < 1 || anchor > MAX_ANCHOR_DAY) {
    throw new DomainValidationError("anchorDay", `must be a day of month between 1 and ${String(MAX_ANCHOR_DAY)}`);
  }
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth();
  // The anchor instant in `at`'s own month. If `at` falls before it, the cycle that contains `at` began
  // the month before — which is the case a naive implementation gets wrong on the first of the month.
  const thisMonth = anchoredAt(year, month, anchor);
  const startsAt = at.getTime() >= thisMonth.getTime() ? thisMonth : anchoredAt(year, month - 1, anchor);
  const endsAt = anchoredAt(startsAt.getUTCFullYear(), startsAt.getUTCMonth() + 1, anchor);
  return { startsAt, endsAt, anchorDay: anchor };
}

/** The next cycle, so a sweep can walk forward without re-deriving the anchor. */
export function nextUsageCycle(cycle: UsageCycleBounds): UsageCycleBounds {
  return usageCycleFor(cycle.anchorDay, cycle.endsAt);
}

/**
 * The anchor instant in one month, clamped to a day that month actually has.
 *
 * `Date.UTC` would roll a 31st February over into March, which would put two cycles in the wrong order;
 * the clamp is what keeps February's boundary inside February.
 */
function anchoredAt(year: number, month: number, anchorDay: number): Date {
  // `Date.UTC` normalizes a month of -1 or 12 into the neighbouring year, so callers may pass either.
  const normalized = new Date(Date.UTC(year, month, 1));
  const lastDay = new Date(Date.UTC(normalized.getUTCFullYear(), normalized.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(normalized.getUTCFullYear(), normalized.getUTCMonth(), Math.min(anchorDay, lastDay)));
}

/** What a reservation attempt is allowed to do. */
export type ReservationVerdict =
  | { readonly kind: "ALLOWED" }
  /** This metric is counted for us, never sold, so there is nothing to reserve against. */
  | { readonly kind: "NOT_A_QUOTA" }
  /** The plan includes none of this metric at all, which is different from having spent it. */
  | { readonly kind: "NOT_INCLUDED" }
  /** Paid work is stopped for this workspace; the allowance is beside the point. */
  | { readonly kind: "NO_PAID_ACCESS" }
  | { readonly kind: "EXHAUSTED"; readonly allowance: number; readonly used: number; readonly remaining: number };

export interface ReservationRequest {
  readonly snapshot: EntitlementSnapshot;
  readonly metric: LedgerMetric;
  /** Already consumed in this cycle. */
  readonly committed: number;
  /** Held by reservations that have not yet been committed or released. */
  readonly reserved: number;
  /**
   * Allowance the workspace bought on top of the plan's included amount (#43).
   *
   * Added to the plan's quota rather than counted separately, because the question here is only "is there
   * room?". *Which* of the two a commit spends is the store's business, and the accepted policy is that
   * the included allowance goes first — so a top-up cannot be spent while the plan's own is untouched.
   */
  readonly purchased?: number;
  readonly amount: number;
}

/**
 * Whether this much of an allowance may be held.
 *
 * Counts reservations against the allowance as well as commitments, which is what stops two concurrent
 * callers each being told there is room for the last unit. The store does the locking; this decides.
 *
 * A zero or negative amount is a programming error rather than a business one, so it throws instead of
 * returning a verdict somebody might render to a customer.
 */
export function reservationVerdict(request: ReservationRequest): ReservationVerdict {
  if (!Number.isFinite(request.amount) || request.amount <= 0) {
    throw new DomainValidationError("amount", "must be a positive number of units");
  }
  if (!hasCustomerQuota(request.metric)) {
    return { kind: "NOT_A_QUOTA" };
  }
  if (!request.snapshot.paidWorkAllowed) {
    return { kind: "NO_PAID_ACCESS" };
  }
  const included = request.snapshot.quotas[request.metric];
  if (included === undefined) {
    // Not the same as exhausted, and it reads differently to the person being told: "your plan does not
    // include this" is answered by changing plan, "you have used it all" by waiting or topping up.
    //
    // A top-up cannot rescue this. The allowance exists because a plan sells it, and a balance bought
    // against a plan that no longer includes the resource is not a licence to use it.
    return { kind: "NOT_INCLUDED" };
  }
  const allowance = included + (request.purchased ?? 0);
  const used = request.committed + request.reserved;
  const remaining = Math.max(0, allowance - used);
  if (used + request.amount > allowance) {
    return { kind: "EXHAUSTED", allowance, used, remaining };
  }
  return { kind: "ALLOWED" };
}

/** How one ledger row moves the two materialized counters. */
export interface UsageDeltas {
  readonly committed: number;
  readonly reserved: number;
}

/**
 * The signed effect of one ledger event, as the two numbers a counter is made of.
 *
 * Every row carries both, which is what makes the counters exactly reconstructable by two column sums —
 * no join, no per-operation state machine replay, no second copy of these rules in the reconciler. A
 * commit moves an amount into `committed` and gives back the hold it was granted, and the two differ
 * whenever the work consumed more or less than it reserved, which for transcription is the ordinary case.
 *
 * `held` is what the reservation was granted, not what the work used. Settling without it would leave the
 * hold on the counter for ever, so it is required rather than defaulted: a missing one is a programming
 * error, and a silently-zero hold is the kind of leak nobody notices until an allowance is unusable.
 */
export function ledgerDeltas(kind: UsageEventKind, input: { readonly amount: number; readonly held?: number }): UsageDeltas {
  switch (kind) {
    case "RECORD":
      return { committed: input.amount, reserved: 0 };
    case "RESERVE":
      return { committed: 0, reserved: input.amount };
    case "COMMIT":
      return { committed: input.amount, reserved: -requireHeld(input.held, "COMMIT") };
    case "RELEASE":
      // Nothing was consumed. The hold goes back and the committed total is untouched, which is the whole
      // difference between a release and a commit of zero.
      return { committed: 0, reserved: -requireHeld(input.held, "RELEASE") };
  }
}

function requireHeld(held: number | undefined, kind: string): number {
  if (held === undefined || !Number.isFinite(held) || held < 0) {
    throw new DomainValidationError("held", `settling a reservation with ${kind} must say how much it held`);
  }
  return held;
}
