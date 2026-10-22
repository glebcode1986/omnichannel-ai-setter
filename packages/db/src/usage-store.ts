/**
 * The usage ledger, its cycles and its reservations (#39, USAGE_METERING.md).
 *
 * Three properties carry this file, and each is enforced by the database rather than by care:
 *
 * **One logical operation is counted once.** Every write names a `usageOperationId` derived from facts
 * fixed before the work started, and `usage_ledger_operation_key` is unique on
 * `(workspace, metric, operation, kind)`. A duplicate worker, a provider retry, a schema repair and a
 * requeued job therefore cannot double-count — not because a caller checked first, which a second worker
 * can lose a race against, but because the second insert is refused.
 *
 * **The last unit of an allowance cannot be sold twice.** A reservation locks the counter row, resolves
 * the entitlement and decides inside that lock, so read, judgement and write describe one instant.
 *
 * **Internal metrics cannot refuse work.** `reserve` against one is refused with `NOT_A_QUOTA`, in this
 * file and again by a CHECK. Core AI replies are included and unmetered in the public plans, and this is
 * how the code says so: there is no path by which an exhausted allowance could hold a reply.
 *
 * Nothing here can stop an inbound message being persisted. Ingestion does not call this file at all.
 *
 * **No expected exception is caught inside a transaction.** In PostgreSQL a failed statement aborts the
 * whole transaction, so "try the insert and catch the duplicate" — which reads fine and works outside one
 * — leaves every later statement failing with `25P02`. Where a conflict is a normal outcome rather than a
 * fault, this file serializes on a transaction-scoped advisory lock and then reads before writing. The
 * unique indexes stay as the backstop for anything that does not come through here.
 */
import {
  hasCustomerQuota,
  ledgerDeltas,
  reservationVerdict,
  usageCycleFor,
  type LedgerMetric,
  type ReservationVerdict,
  type UsageCycleBounds,
  type UsageEventKind,
} from "@omnichannel/domain";

import type { DbClient, DbExecutor } from "./client";
import { consumeTopUp, readTopUpBalance } from "./catalog-store";
import { readEntitlement } from "./entitlement-store";

/**
 * What a ledger row may say about itself.
 *
 * Scalars only. A nested object would still be valid JSON, but the detail exists to explain one line to a
 * person reconciling a bill — and anything that needs a tree belongs on the row it describes rather than
 * in the measurement of it.
 */
export type UsageDetail = Readonly<Record<string, string | number | boolean | null>>;

/** How long an unsettled hold survives before a sweep gives it back. */
export const RESERVATION_TTL_MS = 30 * 60_000;

/** How many stale holds one sweep settles. Bounded so a backlog cannot become one enormous transaction. */
export const RESERVATION_SWEEP_LIMIT = 200;

export interface UsageCycleRecord extends UsageCycleBounds {
  readonly id: string;
}

/**
 * The day of month this workspace's cycles turn over on.
 *
 * Taken from the subscription's own period, because that is what the customer is billed against. The
 * fallbacks are in descending order of how much they mean: the current period's end, then the trial's
 * end, then when the subscription was created, then when the workspace was. The last of these is the only
 * answer available for a workspace that has not started a trial, and it is stable, which is what matters —
 * an anchor that moved would re-attribute consumption that had already happened.
 */
export async function readUsageAnchorDay(db: DbExecutor, workspaceId: string): Promise<number> {
  const [subscription, workspace] = await Promise.all([
    db.workspaceSubscription.findUnique({ where: { workspaceId }, select: { periodEndsAt: true, trialEndsAt: true, createdAt: true } }),
    db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { createdAt: true } }),
  ]);
  const anchor = subscription?.periodEndsAt ?? subscription?.trialEndsAt ?? subscription?.createdAt ?? workspace.createdAt;
  return anchor.getUTCDate();
}

/**
 * The cycle containing `at`, created if this is the first time anybody counted in it.
 *
 * A row rather than arithmetic at read time: a counter must not be able to belong to two periods, and
 * changing the anchor later must not silently re-attribute consumption that has already happened. The
 * boundaries are therefore written down once and then read, never recomputed.
 *
 * Two callers racing to open the same cycle produce one row — `(workspace, startsAt)` is unique, and the
 * loser reads the winner's.
 */
export async function openUsageCycle(db: DbClient, workspaceId: string, at: Date, anchorDay?: number): Promise<UsageCycleRecord> {
  return db.$transaction(async (tx) => openUsageCycleWithin(tx, workspaceId, at, anchorDay));
}

/**
 * The same, inside the caller's transaction.
 *
 * The split matters more here than it looks. The serialization is a *transaction-scoped* advisory lock, so
 * called with a client rather than a transaction each statement would be its own transaction and the lock
 * would be released before it was any use — three concurrent callers would race into a unique violation,
 * which is exactly what the lock exists to avoid.
 */
export async function openUsageCycleWithin(tx: DbExecutor, workspaceId: string, at: Date, anchorDay?: number): Promise<UsageCycleRecord> {
  const anchor = anchorDay ?? (await readUsageAnchorDay(tx, workspaceId));
  const bounds = usageCycleFor(anchor, at);
  // Serialized per workspace and period, so two callers opening the same cycle do not race into a unique
  // violation — which inside a transaction would abort everything that followed it.
  await serialize(tx, `usage-cycle:${workspaceId}:${bounds.startsAt.toISOString()}`);
  const existing = await tx.usageCycle.findUnique({
    where: { workspaceId_startsAt: { workspaceId, startsAt: bounds.startsAt } },
    select: { id: true, anchorDay: true, startsAt: true, endsAt: true },
  });
  if (existing !== null) {
    return { id: existing.id, anchorDay: existing.anchorDay, startsAt: existing.startsAt, endsAt: existing.endsAt };
  }
  const created = await tx.usageCycle.create({
    data: { workspaceId, anchorDay: bounds.anchorDay, startsAt: bounds.startsAt, endsAt: bounds.endsAt },
    select: { id: true, anchorDay: true, startsAt: true, endsAt: true },
  });
  return { id: created.id, anchorDay: created.anchorDay, startsAt: created.startsAt, endsAt: created.endsAt };
}

export interface RecordUsageInput {
  readonly workspaceId: string;
  readonly metric: LedgerMetric;
  /** Derived from facts fixed before the work started, so every attempt produces the same identity. */
  readonly usageOperationId: string;
  readonly amount: number;
  readonly subjectType?: string;
  readonly subjectId?: string;
  readonly detail?: UsageDetail;
  readonly at?: Date;
}

export type RecordUsageOutcome =
  | { readonly status: "RECORDED"; readonly cycleId: string }
  /** This operation was already counted. The answer to a duplicate worker, not an error. */
  | { readonly status: "ALREADY_RECORDED"; readonly cycleId: string };

/**
 * Counts consumption, idempotently, in its own transaction.
 *
 * For callers that have no transaction of their own. A caller that is already writing the work itself
 * should use `recordUsageWithin` instead, so the measurement cannot survive a piece of work that did not —
 * which is the whole difference between telemetry and fiction.
 */
export async function recordUsage(db: DbClient, input: RecordUsageInput): Promise<RecordUsageOutcome> {
  return db.$transaction(async (tx) => recordUsageWithin(tx, input));
}

/**
 * The same write, inside the caller's transaction.
 *
 * Both exist on purpose. Recording in the transaction that records the work makes the two exactly
 * consistent: a rolled-back draft leaves no generation cycle behind, and a replayed one is refused by the
 * ledger's own unique index rather than counted twice.
 */
export async function recordUsageWithin(tx: DbExecutor, input: RecordUsageInput): Promise<RecordUsageOutcome> {
  const at = input.at ?? new Date();
  const amount = requireWholeAmount(input.amount);
  const cycle = await openUsageCycleWithin(tx, input.workspaceId, at);
  // Serialized on the operation's own identity, so a duplicate worker waits rather than colliding. The
  // unique index still backs this up for anything that does not come through this store.
  await serialize(tx, `usage-op:${input.workspaceId}:${input.metric}:${input.usageOperationId}`);
  const already = await tx.usageLedgerEntry.findUnique({
    where: {
      workspaceId_metric_usageOperationId_kind: {
        workspaceId: input.workspaceId,
        metric: input.metric,
        usageOperationId: input.usageOperationId,
        kind: "RECORD",
      },
    },
    select: { cycleId: true },
  });
  if (already !== null) {
    // Counted already. The answer to a duplicate worker, a provider retry or a restarted process — all of
    // which arrive with this same identity, because it is derived from facts fixed before the work began.
    return { status: "ALREADY_RECORDED", cycleId: already.cycleId };
  }

  const deltas = ledgerDeltas("RECORD", { amount });
  await writeLedgerEntry(tx, { ...input, at, kind: "RECORD", cycleId: cycle.id, deltas });
  await bumpCounter(tx, input.workspaceId, cycle.id, input.metric, deltas);
  return { status: "RECORDED", cycleId: cycle.id };
}

export interface ReserveUsageInput {
  readonly workspaceId: string;
  readonly metric: LedgerMetric;
  readonly usageOperationId: string;
  /** What to hold. For transcription this is an estimate; the commit carries the real duration. */
  readonly amount: number;
  readonly subjectType?: string;
  readonly subjectId?: string;
  readonly detail?: UsageDetail;
  readonly at?: Date;
  readonly ttlMs?: number;
}

export type ReserveUsageOutcome =
  | { readonly status: "RESERVED"; readonly reservationId: string; readonly expiresAt: Date; readonly replayed: boolean }
  /** Refused, with the verdict that explains it. The caller may still do unpaid work. */
  | { readonly status: "REFUSED"; readonly verdict: ReservationVerdict }
  /**
   * This operation has already had its hold and settled it.
   *
   * Its own answer rather than a refusal verdict, because it is not a statement about the allowance: the
   * allowance may be untouched. Reporting it as `EXHAUSTED` would send a caller to look at a balance that
   * has nothing to do with why this was refused.
   */
  | { readonly status: "ALREADY_SETTLED"; readonly state: "COMMITTED" | "RELEASED" };

/**
 * Holds part of an allowance while work that may consume it runs.
 *
 * The counter row is locked first and the entitlement is resolved inside that lock, so two callers cannot
 * each be told there is room for the last unit. Reservations count against the allowance as well as
 * commitments, which is the half a naive implementation leaves out.
 *
 * Replaying the same operation returns the hold it already has. That matters more than it looks: a worker
 * that crashed after reserving and before starting the work must not acquire a second hold on retry, or a
 * business loses allowance to our restarts.
 */
export async function reserveUsage(db: DbClient, input: ReserveUsageInput): Promise<ReserveUsageOutcome> {
  const at = input.at ?? new Date();
  const amount = requireWholeAmount(input.amount);
  if (!hasCustomerQuota(input.metric)) {
    // Refused here as well as by a CHECK. A reservation that quietly succeeded would leave its caller
    // believing an allowance had been checked when none exists.
    return { status: "REFUSED", verdict: { kind: "NOT_A_QUOTA" } };
  }
  // Narrowed once, here, because the guard above cannot narrow a property read inside the closure below.
  const metric = input.metric;

  return db.$transaction(async (tx) => {
    const cycle = await openUsageCycleWithin(tx, input.workspaceId, at);
    const existing = await tx.usageReservation.findUnique({
      where: { workspaceId_metric_usageOperationId: { workspaceId: input.workspaceId, metric: input.metric, usageOperationId: input.usageOperationId } },
      select: { id: true, expiresAt: true, state: true },
    });
    if (existing !== null) {
      if (existing.state === "RESERVED") {
        return { status: "RESERVED", reservationId: existing.id, expiresAt: existing.expiresAt, replayed: true };
      }
      // Reserving again under the same operation identity would be a second hold for one piece of work.
      return { status: "ALREADY_SETTLED", state: existing.state === "COMMITTED" ? "COMMITTED" : "RELEASED" };
    }

    const counter = await lockCounter(tx, input.workspaceId, cycle.id, input.metric);
    // Resolved inside the lock, against the same instant the decision is written at. A snapshot read
    // before the lock could have been overtaken by a plan change, and this is a billing boundary.
    const snapshot = await readEntitlement(tx as unknown as DbClient, input.workspaceId, at);
    // Allowance the workspace bought on top of the plan's own (#43). Read inside the lock with
    // everything else, so a top-up arriving mid-decision cannot be counted twice or missed.
    const purchased = await readTopUpBalance(tx, input.workspaceId, metric, at);
    const verdict = reservationVerdict({
      snapshot,
      metric: input.metric,
      committed: counter.committed,
      reserved: counter.reserved,
      purchased: purchased.remaining,
      amount,
    });
    if (verdict.kind !== "ALLOWED") {
      return { status: "REFUSED", verdict };
    }

    const deltas = ledgerDeltas("RESERVE", { amount });
    const expiresAt = new Date(at.getTime() + (input.ttlMs ?? RESERVATION_TTL_MS));
    const reservation = await tx.usageReservation.create({
      data: {
        workspaceId: input.workspaceId,
        cycleId: cycle.id,
        metric: input.metric,
        usageOperationId: input.usageOperationId,
        amount,
        expiresAt,
      },
      select: { id: true },
    });
    await writeLedgerEntry(tx, { ...input, at, kind: "RESERVE", cycleId: cycle.id, deltas });
    await bumpCounter(tx, input.workspaceId, cycle.id, input.metric, deltas);
    return { status: "RESERVED", reservationId: reservation.id, expiresAt, replayed: false };
  });
}

export type SettleReservationOutcome =
  | { readonly status: "COMMITTED"; readonly committed: number; readonly replayed: boolean }
  | { readonly status: "RELEASED"; readonly replayed: boolean }
  /** It was settled the other way. A released hold cannot be committed afterwards, or the reverse. */
  | { readonly status: "ALREADY_SETTLED"; readonly state: "COMMITTED" | "RELEASED" }
  /** No such hold for this operation. */
  | { readonly status: "GONE" };

export interface SettleReservationInput {
  readonly workspaceId: string;
  readonly metric: LedgerMetric;
  readonly usageOperationId: string;
  readonly at?: Date;
  readonly detail?: UsageDetail;
}

/**
 * Records what the work actually consumed, and hands the hold back.
 *
 * `amount` may exceed what was held. The work happened, and a ledger that recorded less than was consumed
 * would understate our own costs; the counter then sits above the allowance, which is what makes the
 * *next* reservation fail. No overage is charged, per the accepted commercial policy.
 *
 * A second commit of the same operation returns the first one's outcome. A commit of something already
 * released is refused — the hold has gone back, and committing against it would count allowance nobody
 * was holding.
 */
export async function commitReservation(
  db: DbClient,
  input: SettleReservationInput & { readonly amount: number },
): Promise<SettleReservationOutcome> {
  const amount = requireWholeAmount(input.amount, { allowZero: true });
  return settle(db, input, "COMMIT", amount);
}

/** Gives a hold back for work that did not happen. Consumes nothing, which is the point. */
export async function releaseReservation(db: DbClient, input: SettleReservationInput): Promise<SettleReservationOutcome> {
  return settle(db, input, "RELEASE", 0);
}

async function settle(
  db: DbClient,
  input: SettleReservationInput,
  kind: "COMMIT" | "RELEASE",
  amount: number,
): Promise<SettleReservationOutcome> {
  const at = input.at ?? new Date();
  return db.$transaction(async (tx) => {
    // Locked before it is read, so two settlements of one hold cannot both see it as unsettled.
    const locked = await tx.$queryRaw<{ id: string; cycle_id: string; amount: number; state: string; committed_amount: number | null }[]>`
      SELECT "id", "cycle_id", "amount", "state"::text AS state, "committed_amount"
      FROM "usage_reservations"
      WHERE "workspace_id" = ${input.workspaceId} AND "metric"::text = ${input.metric} AND "usage_operation_id" = ${input.usageOperationId}
      FOR UPDATE`;
    const row = locked[0];
    if (row === undefined) {
      return { status: "GONE" };
    }
    if (row.state !== "RESERVED") {
      const settledAs = row.state === "COMMITTED" ? "COMMITTED" : "RELEASED";
      if (settledAs !== (kind === "COMMIT" ? "COMMITTED" : "RELEASED")) {
        return { status: "ALREADY_SETTLED", state: settledAs };
      }
      // The same settlement arriving twice is one decision reported twice.
      return kind === "COMMIT"
        ? { status: "COMMITTED", committed: row.committed_amount ?? 0, replayed: true }
        : { status: "RELEASED", replayed: true };
    }

    if (kind === "COMMIT" && amount > 0) {
      // Which of the two allowances this spent (#43). The accepted policy is that the plan's included
      // amount goes first, so only what spills past it is taken from a bought balance — computed from the
      // counter before and after, which attributes a commit that straddles the boundary exactly rather
      // than rounding it to one side.
      await spendPurchasedAllowance(tx, input.workspaceId, input.metric, row.cycle_id, amount, at);
    }
    const deltas = ledgerDeltas(kind, { amount, held: row.amount });
    await writeLedgerEntry(tx, {
      workspaceId: input.workspaceId,
      metric: input.metric,
      usageOperationId: input.usageOperationId,
      ...(input.detail === undefined ? {} : { detail: input.detail }),
      at,
      kind,
      cycleId: row.cycle_id,
      deltas,
    });
    await tx.usageReservation.update({
      where: { id: row.id },
      data: {
        state: kind === "COMMIT" ? "COMMITTED" : "RELEASED",
        settledAt: at,
        ...(kind === "COMMIT" ? { committedAmount: amount } : {}),
      },
    });
    await bumpCounter(tx, input.workspaceId, row.cycle_id, input.metric, deltas);
    return kind === "COMMIT" ? { status: "COMMITTED", committed: amount, replayed: false } : { status: "RELEASED", replayed: false };
  });
}

/**
 * Takes from the bought balance whatever this commit spends beyond the plan's included allowance.
 *
 * The counter tracks one total against the included amount, so the part of it that exceeds the plan is
 * the part a top-up paid for. Comparing the overflow before and after the commit attributes a commit that
 * straddles the boundary exactly: twenty seconds committed against an allowance with five left takes five
 * from the plan and fifteen from the balance, rather than all twenty from one of them.
 *
 * Nothing left to take is not an error here. A commit records work that already happened, and the ledger's
 * own counter is the record of it; a balance that could not cover the overflow means the *next*
 * reservation is refused, which is the policy rather than a failure of this one.
 */
async function spendPurchasedAllowance(
  tx: DbExecutor,
  workspaceId: string,
  metric: LedgerMetric,
  cycleId: string,
  amount: number,
  at: Date,
): Promise<void> {
  if (!hasCustomerQuota(metric)) {
    return;
  }
  const sold = metric;
  const snapshot = await readEntitlement(tx as unknown as DbClient, workspaceId, at);
  const included = snapshot.quotas[sold] ?? 0;
  const counter = await tx.usageCounter.findUnique({
    where: { workspaceId_cycleId_metric: { workspaceId, cycleId, metric } },
    select: { committed: true },
  });
  const before = counter?.committed ?? 0;
  const overflow = Math.max(0, before + amount - included) - Math.max(0, before - included);
  if (overflow > 0) {
    await consumeTopUp(tx, workspaceId, sold, overflow, at);
  }
}

/**
 * Gives back holds nobody settled.
 *
 * Without this a worker that died between reserving and finishing would keep part of a business's
 * allowance until the cycle turned over. Each expiry is its own release, so the ledger explains where the
 * allowance went rather than it simply reappearing.
 */
export async function expireStaleReservations(db: DbClient, at = new Date(), limit = RESERVATION_SWEEP_LIMIT): Promise<number> {
  const stale = await db.usageReservation.findMany({
    where: { state: "RESERVED", expiresAt: { lte: at } },
    orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
    take: limit,
    select: { workspaceId: true, metric: true, usageOperationId: true },
  });
  let released = 0;
  for (const row of stale) {
    const outcome = await releaseReservation(db, {
      workspaceId: row.workspaceId,
      metric: row.metric,
      usageOperationId: row.usageOperationId,
      at,
      detail: { reason: "EXPIRED" },
    });
    if (outcome.status === "RELEASED" && !outcome.replayed) {
      released += 1;
    }
  }
  return released;
}

export interface UsageSnapshot {
  readonly cycle: UsageCycleRecord;
  /** One entry per metric that has been counted in this cycle. An absent metric has had no activity. */
  readonly counters: Readonly<Partial<Record<LedgerMetric, { readonly committed: number; readonly reserved: number }>>>;
}

/**
 * What a workspace has used in the cycle containing `at`.
 *
 * Opened rather than merely read, so the first question about a cycle does not answer "there is no cycle"
 * — a workspace that has consumed nothing has used nothing, which is a number rather than an absence.
 */
/**
 * The same counters, without writing anything (#59).
 *
 * `readUsage` is not a read: it opens the cycle, and opening a cycle *creates the row* when nobody has
 * counted in that period yet. For the customer's own screens that is right — the page is a side effect of
 * a tenant using the product. For the internal console it is not: an operator opening a workspace's usage
 * panel would write a `usage_cycles` row into that tenant, with no actor and no audit trail, and it would
 * fail "every sensitive operator action is attributable" on the first page load, in the one direction
 * nobody looks because the panel is documented as read-only.
 *
 * So this computes the boundaries with `usageCycleFor` and reports zeros when no row exists. The cycle it
 * returns has no id, which is deliberate: there is nothing to reserve against, and a caller that wanted to
 * write would have to go and open one properly.
 */
export async function readUsageSnapshot(
  db: DbExecutor,
  workspaceId: string,
  at = new Date(),
): Promise<{ readonly bounds: UsageCycleBounds; readonly counters: UsageSnapshot["counters"]; readonly cycleOpened: boolean }> {
  const anchor = await readUsageAnchorDay(db, workspaceId);
  const bounds = usageCycleFor(anchor, at);
  const cycle = await db.usageCycle.findUnique({
    where: { workspaceId_startsAt: { workspaceId, startsAt: bounds.startsAt } },
    select: { id: true },
  });
  if (cycle === null) {
    return { bounds, counters: {}, cycleOpened: false };
  }
  const rows = await db.usageCounter.findMany({
    where: { workspaceId, cycleId: cycle.id },
    select: { metric: true, committed: true, reserved: true },
  });
  const counters: Partial<Record<LedgerMetric, { committed: number; reserved: number }>> = {};
  for (const row of rows) {
    counters[row.metric] = { committed: row.committed, reserved: row.reserved };
  }
  return { bounds, counters, cycleOpened: true };
}

export async function readUsage(db: DbClient, workspaceId: string, at = new Date()): Promise<UsageSnapshot> {
  return db.$transaction(async (tx) => {
    const cycle = await openUsageCycleWithin(tx, workspaceId, at);
    const rows = await tx.usageCounter.findMany({
      where: { workspaceId, cycleId: cycle.id },
      select: { metric: true, committed: true, reserved: true },
    });
    const counters: Partial<Record<LedgerMetric, { committed: number; reserved: number }>> = {};
    for (const row of rows) {
      counters[row.metric] = { committed: row.committed, reserved: row.reserved };
    }
    return { cycle, counters };
  });
}

export interface CounterDifference {
  readonly metric: LedgerMetric;
  readonly counter: { readonly committed: number; readonly reserved: number };
  readonly ledger: { readonly committed: number; readonly reserved: number };
}

/**
 * Checks the materialized counters against the ledger they summarize.
 *
 * It reports and does not repair. A counter that healed itself would hide the bug that broke it, and the
 * difference is the only evidence that something wrote one without the other.
 *
 * The comparison is two column sums because every ledger row carries both deltas — there is no second
 * copy of the arithmetic here, so this is a check of the counters rather than of these rules against
 * themselves.
 */
export async function reconcileUsageCounters(db: DbClient, workspaceId: string, cycleId: string): Promise<readonly CounterDifference[]> {
  const [counters, sums] = await Promise.all([
    db.usageCounter.findMany({ where: { workspaceId, cycleId }, select: { metric: true, committed: true, reserved: true } }),
    db.usageLedgerEntry.groupBy({
      by: ["metric"],
      where: { workspaceId, cycleId },
      _sum: { committedDelta: true, reservedDelta: true },
    }),
  ]);

  const differences: CounterDifference[] = [];
  const metrics = new Set<LedgerMetric>([...counters.map((row) => row.metric), ...sums.map((row) => row.metric)]);
  for (const metric of metrics) {
    const counter = counters.find((row) => row.metric === metric);
    const sum = sums.find((row) => row.metric === metric);
    const left = { committed: counter?.committed ?? 0, reserved: counter?.reserved ?? 0 };
    const right = { committed: sum?._sum.committedDelta ?? 0, reserved: sum?._sum.reservedDelta ?? 0 };
    if (left.committed !== right.committed || left.reserved !== right.reserved) {
      differences.push({ metric, counter: left, ledger: right });
    }
  }
  return differences;
}

interface LedgerWrite {
  readonly workspaceId: string;
  readonly cycleId: string;
  readonly metric: LedgerMetric;
  readonly kind: UsageEventKind;
  readonly usageOperationId: string;
  readonly deltas: { readonly committed: number; readonly reserved: number };
  readonly subjectType?: string;
  readonly subjectId?: string;
  readonly detail?: UsageDetail;
  readonly at: Date;
}

async function writeLedgerEntry(tx: DbExecutor, write: LedgerWrite): Promise<void> {
  await tx.usageLedgerEntry.create({
    data: {
      workspaceId: write.workspaceId,
      cycleId: write.cycleId,
      metric: write.metric,
      kind: write.kind,
      usageOperationId: write.usageOperationId,
      committedDelta: write.deltas.committed,
      reservedDelta: write.deltas.reserved,
      ...(write.subjectType === undefined ? {} : { subjectType: write.subjectType }),
      ...(write.subjectId === undefined ? {} : { subjectId: write.subjectId }),
      ...(write.detail === undefined ? {} : { detail: write.detail }),
      recordedAt: write.at,
    },
  });
}

/**
 * Moves the materialized totals by one row's deltas.
 *
 * `increment` rather than a read and a write, so two operations counting at once do not lose one of the
 * two. The CHECK refuses a negative total, which is where a double release or a lost hold shows up as a
 * refused write rather than as an allowance that quietly grew.
 *
 * Update-then-create rather than an upsert, and that is not a style choice: PostgreSQL validates CHECK
 * constraints against the proposed tuple of an `INSERT ... ON CONFLICT DO UPDATE` even when the conflict
 * path is the one that runs. A settlement's deltas are negative, so an upsert was refused by
 * `usage_counters_non_negative_check` for a row that already existed and was about to be decremented
 * correctly.
 */
async function bumpCounter(
  tx: DbExecutor,
  workspaceId: string,
  cycleId: string,
  metric: LedgerMetric,
  deltas: { readonly committed: number; readonly reserved: number },
): Promise<void> {
  const moved = await tx.usageCounter.updateMany({
    where: { workspaceId, cycleId, metric },
    data: { committed: { increment: deltas.committed }, reserved: { increment: deltas.reserved } },
  });
  if (moved.count > 0) {
    return;
  }
  // First activity for this metric in this cycle. Serialized first, so two of these cannot race into a
  // unique violation; a negative delta here would be a settlement against a hold that was never counted,
  // and the CHECK refusing it is how that would be found.
  await serialize(tx, counterKey(workspaceId, cycleId, metric));
  const retried = await tx.usageCounter.updateMany({
    where: { workspaceId, cycleId, metric },
    data: { committed: { increment: deltas.committed }, reserved: { increment: deltas.reserved } },
  });
  if (retried.count === 0) {
    await tx.usageCounter.create({ data: { workspaceId, cycleId, metric, committed: deltas.committed, reserved: deltas.reserved } });
  }
}

/**
 * The counter row, locked, created if this metric has not been counted in this cycle yet.
 *
 * The lock is the whole mechanism by which the last unit of an allowance is sold once. `FOR UPDATE` on a
 * row that does not exist locks nothing, so the row is created first — under the same advisory lock, so
 * two callers creating it cannot collide.
 */
async function lockCounter(
  tx: DbExecutor,
  workspaceId: string,
  cycleId: string,
  metric: LedgerMetric,
): Promise<{ readonly committed: number; readonly reserved: number }> {
  await serialize(tx, counterKey(workspaceId, cycleId, metric));
  const existing = await tx.usageCounter.findUnique({
    where: { workspaceId_cycleId_metric: { workspaceId, cycleId, metric } },
    select: { committed: true, reserved: true },
  });
  if (existing === null) {
    await tx.usageCounter.create({ data: { workspaceId, cycleId, metric } });
    return { committed: 0, reserved: 0 };
  }
  // Still taken, so a concurrent settlement of an existing hold serializes behind this decision too.
  await tx.$queryRaw`
    SELECT 1 FROM "usage_counters"
    WHERE "workspace_id" = ${workspaceId} AND "cycle_id" = ${cycleId} AND "metric"::text = ${metric}
    FOR UPDATE`;
  return existing;
}

function counterKey(workspaceId: string, cycleId: string, metric: LedgerMetric): string {
  return `usage-counter:${workspaceId}:${cycleId}:${metric}`;
}

/**
 * Takes a transaction-scoped advisory lock on a name.
 *
 * Released when the transaction ends, however it ends, so there is nothing to leak. Used wherever a
 * conflict is an ordinary outcome rather than a fault: waiting for a lock costs microseconds, and an
 * aborted transaction costs the whole operation.
 */
async function serialize(tx: DbExecutor, name: string): Promise<void> {
  // Called in `FROM` and given a column, because the lock function returns `void` and the client cannot
  // deserialize a void column.
  await tx.$queryRaw`SELECT true AS locked FROM pg_advisory_xact_lock(hashtextextended(${name}, 0))`;
}

/**
 * Amounts are whole units.
 *
 * Seconds and generation cycles are both counted in integers, and a fractional second would silently
 * truncate in the column — which is a measurement error rather than a rounding convention, so it is
 * refused where it can still be seen.
 */
function requireWholeAmount(amount: number, options: { readonly allowZero?: boolean } = {}): number {
  const floor = options.allowZero === true ? 0 : 1;
  if (!Number.isSafeInteger(amount) || amount < floor) {
    throw new Error(`usage amount must be a whole number of units, at least ${String(floor)}`);
  }
  return amount;
}
