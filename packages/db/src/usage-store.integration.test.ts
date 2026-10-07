/**
 * The usage ledger against a real server (#39, USAGE_METERING.md).
 *
 * Three properties carry this file, and none of them can be tested without a database, because in every
 * case the thing being tested is a constraint or a lock rather than a branch:
 *
 * **One logical operation is counted once.** A duplicate worker, a provider retry and a restarted process
 * all arrive with the same `usageOperationId`, and it is the unique index that refuses the second write —
 * so the test that means anything writes it twice.
 *
 * **The last unit of an allowance is sold once.** Two reservations run concurrently against an allowance
 * with room for one, and exactly one of them gets it.
 *
 * **An internal metric cannot refuse work.** Core AI replies are included and unmetered, and the test for
 * that tries to reserve against the metric and is told there is nothing to reserve.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { publishPlanVersion, setWorkspaceSubscription } from "./entitlement-store";
import {
  commitReservation,
  expireStaleReservations,
  openUsageCycle,
  readUsage,
  readUsageAnchorDay,
  reconcileUsageCounters,
  recordUsage,
  releaseReservation,
  reserveUsage,
} from "./usage-store";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { seedWorkspace, type SeededWorkspace } from "./testing/fixtures";

const NOW = new Date("2026-10-20T12:00:00.000Z");

describe.skipIf(!databaseTestsEnabled())("the usage ledger", () => {
  let database: TestDatabase;
  let workspace: SeededWorkspace;
  let neighbour: SeededWorkspace;
  let planVersionId: string;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    workspace = await seedWorkspace(database.db, "usage");
    neighbour = await seedWorkspace(database.db, "usage-neighbour");

    // A plan that sells sixty seconds of transcription, so "exhausted" is reachable in a test rather than
    // only in a spreadsheet.
    const plan = await publishPlanVersion(database.db, {
      code: "usage-test",
      name: "Usage test plan",
      grants: { features: ["AI_DRAFTS", "VOICE_TRANSCRIPTION"], limits: {}, quotas: { VOICE_TRANSCRIPTION_SECONDS: 60 } },
    });
    planVersionId = plan.planVersionId;
    for (const seeded of [workspace, neighbour]) {
      await setWorkspaceSubscription(database.db, seeded.context, { planVersionId, state: "ACTIVE" });
    }
  }, 300_000);

  afterAll(async () => {
    await database?.dispose();
  });

  const db = () => database.db;
  const ws = () => workspace.workspaceId;

  /** A distinct operation identity per test, so no test can be made to pass by another one's rows. */
  let sequence = 0;
  const operation = (label: string) => {
    sequence += 1;
    return `${label}-${String(sequence)}`;
  };

  /**
   * A workspace of its own, on the same sixty-second plan.
   *
   * The reservation tests each want the whole allowance, and sharing one workspace between them would
   * make every assertion depend on the order the file happens to run in — or on a reset helper that
   * rewrote the very counters and ledger rows the tests are about, which would let them pass against a
   * store that never wrote any.
   */
  const freshWorkspace = async (label: string) => {
    sequence += 1;
    const seeded = await seedWorkspace(database.db, `usage-${label}-${String(sequence)}`);
    await setWorkspaceSubscription(database.db, seeded.context, { planVersionId: planVersionId, state: "ACTIVE" });
    return seeded.workspaceId;
  };

  const counterFor = async (workspaceId: string, metric: "VOICE_TRANSCRIPTION_SECONDS" | "AI_GENERATION_CYCLES" | "SIMULATION_GENERATION_CYCLES") => {
    const snapshot = await readUsage(db(), workspaceId, NOW);
    return snapshot.counters[metric] ?? { committed: 0, reserved: 0 };
  };

  describe("counting one logical operation", () => {
    it("counts it once, however many times it arrives", async () => {
      const usageOperationId = operation("duplicate-worker");
      const before = await counterFor(ws(), "AI_GENERATION_CYCLES");

      const first = await recordUsage(db(), { workspaceId: ws(), metric: "AI_GENERATION_CYCLES", usageOperationId, amount: 1, at: NOW });
      const second = await recordUsage(db(), { workspaceId: ws(), metric: "AI_GENERATION_CYCLES", usageOperationId, amount: 1, at: NOW });
      // A third from a restarted process, for which the identity is the same because it is derived from
      // facts fixed before the work started.
      const third = await recordUsage(db(), { workspaceId: ws(), metric: "AI_GENERATION_CYCLES", usageOperationId, amount: 1, at: NOW });

      expect(first.status).toBe("RECORDED");
      expect(second.status).toBe("ALREADY_RECORDED");
      expect(third.status).toBe("ALREADY_RECORDED");
      expect((await counterFor(ws(), "AI_GENERATION_CYCLES")).committed).toBe(before.committed + 1);
      expect(await db().usageLedgerEntry.count({ where: { workspaceId: ws(), usageOperationId } })).toBe(1);
    }, 300_000);

    it("refuses a second row for the same operation at the database, not only in code", async () => {
      const usageOperationId = operation("raw-duplicate");
      const recorded = await recordUsage(db(), { workspaceId: ws(), metric: "AI_GENERATION_CYCLES", usageOperationId, amount: 1, at: NOW });
      if (recorded.status !== "RECORDED") {
        throw new Error(`the fixture expected RECORDED, got ${recorded.status}`);
      }

      // The invariant has to hold for a migration, a console session and any code written after this one,
      // so it is an index — and the test that means anything tries to go round the store.
      await expect(
        db().$executeRaw`
          INSERT INTO "usage_ledger_entries" ("id", "workspace_id", "cycle_id", "metric", "kind", "usage_operation_id", "committed_delta", "reserved_delta")
          SELECT gen_random_uuid()::text, ${ws()}, ${recorded.cycleId}, 'AI_GENERATION_CYCLES', 'RECORD', ${usageOperationId}, 1, 0`,
      ).rejects.toThrow(/usage_ledger_operation_key/u);
    }, 300_000);

    it("counts the same operation identity separately for different metrics", async () => {
      // The index is per metric on purpose: one job may consume two different things, and the identity of
      // the job is not the identity of what it spent.
      const usageOperationId = operation("two-metrics");
      await recordUsage(db(), { workspaceId: ws(), metric: "AI_GENERATION_CYCLES", usageOperationId, amount: 1, at: NOW });
      const other = await recordUsage(db(), { workspaceId: ws(), metric: "SIMULATION_GENERATION_CYCLES", usageOperationId, amount: 1, at: NOW });

      expect(other.status).toBe("RECORDED");
    }, 300_000);

    it("keeps one workspace's counting out of another's", async () => {
      const usageOperationId = operation("shared-identity");
      const before = await counterFor(neighbour.workspaceId, "AI_GENERATION_CYCLES");

      await recordUsage(db(), { workspaceId: ws(), metric: "AI_GENERATION_CYCLES", usageOperationId, amount: 1, at: NOW });
      const theirs = await recordUsage(db(), {
        workspaceId: neighbour.workspaceId,
        metric: "AI_GENERATION_CYCLES",
        usageOperationId,
        amount: 1,
        at: NOW,
      });

      // The same identity in two workspaces is two operations. Scoping the index to the workspace is what
      // stops one tenant's job silently suppressing another's.
      expect(theirs.status).toBe("RECORDED");
      expect((await counterFor(neighbour.workspaceId, "AI_GENERATION_CYCLES")).committed).toBe(before.committed + 1);
    }, 300_000);
  });

  describe("cycles", () => {
    it("opens one cycle for one period, however many callers ask at once", async () => {
      const w = await freshWorkspace("opens-one-cycle-for-one-peri");
      const [first, ...rest] = await Promise.all([
        openUsageCycle(db(), w, NOW),
        openUsageCycle(db(), w, NOW),
        openUsageCycle(db(), w, NOW),
      ]);

      expect(rest.every((cycle) => cycle.id === first?.id)).toBe(true);
    }, 300_000);

    it("puts an operation after the boundary in the next cycle", async () => {
      const w = await freshWorkspace("puts-an-operation-after-the");
      const cycle = await openUsageCycle(db(), w, NOW);
      const next = await recordUsage(db(), {
        workspaceId: w,
        metric: "AI_GENERATION_CYCLES",
        usageOperationId: operation("next-cycle"),
        amount: 1,
        at: cycle.endsAt,
      });

      // Half-open boundaries: the instant a cycle ends belongs to the one that begins.
      expect(next.cycleId).not.toBe(cycle.id);
      expect((await db().usageCycle.findUniqueOrThrow({ where: { id: next.cycleId }, select: { startsAt: true } })).startsAt.getTime()).toBe(
        cycle.endsAt.getTime(),
      );
    }, 300_000);

    it("anchors the cycle on the subscription's own day", async () => {
      const w = await freshWorkspace("anchors-the-cycle-on-the-sub");
      const anchor = await readUsageAnchorDay(db(), w);
      const cycle = await openUsageCycle(db(), w, NOW);

      expect(cycle.anchorDay).toBe(anchor);
      expect(cycle.startsAt.getUTCDate()).toBe(anchor);
    }, 300_000);

    it("counts into the cycle the operation happened in, not the one being asked about", async () => {
      const w = await freshWorkspace("counts-into-the-cycle-the-op");
      const cycle = await openUsageCycle(db(), w, NOW);
      const later = new Date(cycle.endsAt.getTime() + 60_000);
      await recordUsage(db(), { workspaceId: w, metric: "AI_GENERATION_CYCLES", usageOperationId: operation("later"), amount: 5, at: later });

      // A cycle's own total does not move because time passed, which is what makes a past period's
      // numbers answerable at all.
      const thisCycle = await readUsage(db(), w, NOW);
      const nextCycle = await readUsage(db(), w, later);
      expect(nextCycle.cycle.id).not.toBe(thisCycle.cycle.id);
      expect(nextCycle.counters["AI_GENERATION_CYCLES"]?.committed).toBe(5);
    }, 300_000);
  });

  describe("reserving a sold allowance", () => {
    it("holds it, then commits what the work actually used", async () => {
      const w = await freshWorkspace("holds-it-then-commits-what-t");
      const usageOperationId = operation("transcribe");

      const reserved = await reserveUsage(db(), { workspaceId: w, metric: "VOICE_TRANSCRIPTION_SECONDS", usageOperationId, amount: 30, at: NOW });
      const held = await counterFor(w, "VOICE_TRANSCRIPTION_SECONDS");
      const committed = await commitReservation(db(), { workspaceId: w, metric: "VOICE_TRANSCRIPTION_SECONDS", usageOperationId, amount: 22, at: NOW });
      const after = await counterFor(w, "VOICE_TRANSCRIPTION_SECONDS");

      expect(reserved.status).toBe("RESERVED");
      expect(held).toEqual({ committed: 0, reserved: 30 });
      expect(committed).toMatchObject({ status: "COMMITTED", committed: 22, replayed: false });
      // The hold goes back whole and the real duration is what is counted — transcription reserves an
      // estimate and learns the truth afterwards, so the two differ by design.
      expect(after).toEqual({ committed: 22, reserved: 0 });
    }, 300_000);

    it("sells the last unit once, under two concurrent callers", async () => {
      const w = await freshWorkspace("sells-the-last-unit-once-und");
      const first = operation("race-a");
      const second = operation("race-b");

      // Sixty seconds of allowance and two callers each wanting all of it.
      const outcomes = await Promise.all([
        reserveUsage(db(), { workspaceId: w, metric: "VOICE_TRANSCRIPTION_SECONDS", usageOperationId: first, amount: 60, at: NOW }),
        reserveUsage(db(), { workspaceId: w, metric: "VOICE_TRANSCRIPTION_SECONDS", usageOperationId: second, amount: 60, at: NOW }),
      ]);

      const granted = outcomes.filter((outcome) => outcome.status === "RESERVED");
      const refused = outcomes.filter((outcome) => outcome.status === "REFUSED");
      expect(granted).toHaveLength(1);
      expect(refused[0]).toMatchObject({ status: "REFUSED", verdict: { kind: "EXHAUSTED" } });
      expect((await counterFor(w, "VOICE_TRANSCRIPTION_SECONDS")).reserved).toBe(60);
    }, 300_000);

    it("counts other holds against the allowance, not only what was spent", async () => {
      const w = await freshWorkspace("counts-other-holds-against-t");
      const first = operation("hold-a");
      await reserveUsage(db(), { workspaceId: w, metric: "VOICE_TRANSCRIPTION_SECONDS", usageOperationId: first, amount: 50, at: NOW });

      const refused = await reserveUsage(db(), {
        workspaceId: w,
        metric: "VOICE_TRANSCRIPTION_SECONDS",
        usageOperationId: operation("hold-b"),
        amount: 20,
        at: NOW,
      });

      expect(refused).toMatchObject({ status: "REFUSED", verdict: { kind: "EXHAUSTED", remaining: 10 } });
    }, 300_000);

    it("gives a hold back when the work did not happen", async () => {
      const w = await freshWorkspace("gives-a-hold-back-when-the-w");
      const usageOperationId = operation("released");
      await reserveUsage(db(), { workspaceId: w, metric: "VOICE_TRANSCRIPTION_SECONDS", usageOperationId, amount: 40, at: NOW });

      const released = await releaseReservation(db(), { workspaceId: w, metric: "VOICE_TRANSCRIPTION_SECONDS", usageOperationId, at: NOW });

      expect(released).toMatchObject({ status: "RELEASED", replayed: false });
      // Nothing consumed. That is the whole difference between a release and a commit of zero.
      expect(await counterFor(w, "VOICE_TRANSCRIPTION_SECONDS")).toEqual({ committed: 0, reserved: 0 });
    }, 300_000);

    it("answers a retried reserve with the hold it already has", async () => {
      const w = await freshWorkspace("answers-a-retried-reserve-wi");
      const usageOperationId = operation("retried-reserve");
      const first = await reserveUsage(db(), { workspaceId: w, metric: "VOICE_TRANSCRIPTION_SECONDS", usageOperationId, amount: 30, at: NOW });

      const again = await reserveUsage(db(), { workspaceId: w, metric: "VOICE_TRANSCRIPTION_SECONDS", usageOperationId, amount: 30, at: NOW });

      // A worker that crashed after reserving must not take a second hold on retry, or a business loses
      // allowance to our restarts.
      expect(again).toMatchObject({ status: "RESERVED", replayed: true });
      expect(first.status === "RESERVED" && again.status === "RESERVED" && again.reservationId === first.reservationId).toBe(true);
      expect((await counterFor(w, "VOICE_TRANSCRIPTION_SECONDS")).reserved).toBe(30);
    }, 300_000);

    it("answers a retried commit with the first one's outcome", async () => {
      const w = await freshWorkspace("answers-a-retried-commit-wit");
      const usageOperationId = operation("retried-commit");
      await reserveUsage(db(), { workspaceId: w, metric: "VOICE_TRANSCRIPTION_SECONDS", usageOperationId, amount: 30, at: NOW });
      await commitReservation(db(), { workspaceId: w, metric: "VOICE_TRANSCRIPTION_SECONDS", usageOperationId, amount: 18, at: NOW });

      const again = await commitReservation(db(), { workspaceId: w, metric: "VOICE_TRANSCRIPTION_SECONDS", usageOperationId, amount: 18, at: NOW });

      expect(again).toEqual({ status: "COMMITTED", committed: 18, replayed: true });
      expect((await counterFor(w, "VOICE_TRANSCRIPTION_SECONDS")).committed).toBe(18);
    }, 300_000);

    it("refuses to commit a hold that was already given back", async () => {
      const w = await freshWorkspace("refuses-to-commit-a-hold-tha");
      const usageOperationId = operation("committed-after-release");
      await reserveUsage(db(), { workspaceId: w, metric: "VOICE_TRANSCRIPTION_SECONDS", usageOperationId, amount: 30, at: NOW });
      await releaseReservation(db(), { workspaceId: w, metric: "VOICE_TRANSCRIPTION_SECONDS", usageOperationId, at: NOW });

      const committed = await commitReservation(db(), { workspaceId: w, metric: "VOICE_TRANSCRIPTION_SECONDS", usageOperationId, amount: 10, at: NOW });

      // The allowance has gone back. Committing against it would count allowance nobody was holding.
      expect(committed).toEqual({ status: "ALREADY_SETTLED", state: "RELEASED" });
      expect(await counterFor(w, "VOICE_TRANSCRIPTION_SECONDS")).toEqual({ committed: 0, reserved: 0 });
    }, 300_000);

    it("reports a settlement for a hold that never existed rather than inventing one", async () => {
      const w = await freshWorkspace("reports-a-settlement-for-a-h");
      expect(
        await commitReservation(db(), { workspaceId: w, metric: "VOICE_TRANSCRIPTION_SECONDS", usageOperationId: operation("absent"), amount: 1, at: NOW }),
      ).toEqual({ status: "GONE" });
    }, 300_000);

    it("records more than was held when the work turned out larger, and refuses the next hold", async () => {
      const w = await freshWorkspace("records-more-than-was-held-w");
      const usageOperationId = operation("overrun");
      await reserveUsage(db(), { workspaceId: w, metric: "VOICE_TRANSCRIPTION_SECONDS", usageOperationId, amount: 30, at: NOW });

      await commitReservation(db(), { workspaceId: w, metric: "VOICE_TRANSCRIPTION_SECONDS", usageOperationId, amount: 75, at: NOW });

      // The work happened: a ledger recording less than was consumed would understate our own costs. No
      // overage is charged — it is the *next* reservation that is refused.
      expect((await counterFor(w, "VOICE_TRANSCRIPTION_SECONDS")).committed).toBe(75);
      expect(
        await reserveUsage(db(), { workspaceId: w, metric: "VOICE_TRANSCRIPTION_SECONDS", usageOperationId: operation("after-overrun"), amount: 1, at: NOW }),
      ).toMatchObject({ status: "REFUSED", verdict: { kind: "EXHAUSTED", remaining: 0 } });
    }, 300_000);

    it("gives back a hold nobody settled", async () => {
      const w = await freshWorkspace("gives-back-a-hold-nobody-set");
      const usageOperationId = operation("abandoned");
      await reserveUsage(db(), {
        workspaceId: w,
        metric: "VOICE_TRANSCRIPTION_SECONDS",
        usageOperationId,
        amount: 45,
        at: NOW,
        ttlMs: 1_000,
      });

      const released = await expireStaleReservations(db(), new Date(NOW.getTime() + 60_000));

      // Without the sweep a worker that died mid-transcription would keep a business's minutes until the
      // cycle turned over.
      expect(released).toBeGreaterThanOrEqual(1);
      expect((await counterFor(w, "VOICE_TRANSCRIPTION_SECONDS")).reserved).toBe(0);
      const row = await db().usageReservation.findFirstOrThrow({ where: { workspaceId: w, usageOperationId }, select: { state: true } });
      expect(row.state).toBe("RELEASED");
    }, 300_000);

    it("leaves a hold that has not expired alone", async () => {
      const w = await freshWorkspace("leaves-a-hold-that-has-not-e");
      const usageOperationId = operation("still-running");
      await reserveUsage(db(), { workspaceId: w, metric: "VOICE_TRANSCRIPTION_SECONDS", usageOperationId, amount: 20, at: NOW, ttlMs: 600_000 });

      await expireStaleReservations(db(), new Date(NOW.getTime() + 60_000));

      expect((await counterFor(w, "VOICE_TRANSCRIPTION_SECONDS")).reserved).toBe(20);
    }, 300_000);
  });

  describe("what cannot be reserved", () => {
    it("refuses an internal metric rather than quietly succeeding", async () => {
      const w = await freshWorkspace("refuses-an-internal-metric-r");
      // Core AI replies are included and unmetered, so there is no allowance to hold — and a reservation
      // that did nothing would leave its caller believing it had checked one.
      expect(
        await reserveUsage(db(), { workspaceId: w, metric: "AI_GENERATION_CYCLES", usageOperationId: operation("not-a-quota"), amount: 1, at: NOW }),
      ).toEqual({ status: "REFUSED", verdict: { kind: "NOT_A_QUOTA" } });
      expect(await db().usageReservation.count({ where: { workspaceId: w, metric: "AI_GENERATION_CYCLES" } })).toBe(0);
    }, 300_000);

    it("refuses one in raw SQL too, so the rule holds for anything written after this", async () => {
      const w = await freshWorkspace("refuses-one-in-raw-sql-too-s");
      const cycle = await openUsageCycle(db(), w, NOW);

      await expect(
        db().$executeRaw`
          INSERT INTO "usage_reservations" ("id", "workspace_id", "cycle_id", "metric", "usage_operation_id", "amount", "expires_at")
          VALUES (gen_random_uuid()::text, ${w}, ${cycle.id}, 'AI_GENERATION_CYCLES', ${operation("raw-quota")}, 1, ${NOW})`,
      ).rejects.toThrow(/usage_reservations_quota_metric_check/u);
    }, 300_000);

    it("still counts an internal metric while refusing to reserve it", async () => {
      const w = await freshWorkspace("still-counts-an-internal-met");
      // The whole point of the separation: unmetered to the customer, visible to us.
      const recorded = await recordUsage(db(), { workspaceId: w, metric: "AI_GENERATION_CYCLES", usageOperationId: operation("unmetered"), amount: 1, at: NOW });

      expect(recorded.status).toBe("RECORDED");
    }, 300_000);
  });

  describe("reconciliation", () => {
    it("finds nothing to report when the counters match the ledger", async () => {
      const w = await freshWorkspace("finds-nothing-to-report-when");
      const cycle = await openUsageCycle(db(), w, NOW);
      await recordUsage(db(), { workspaceId: w, metric: "AI_GENERATION_CYCLES", usageOperationId: operation("reconciled"), amount: 2, at: NOW });

      expect(await reconcileUsageCounters(db(), w, cycle.id)).toEqual([]);
    }, 300_000);

    it("reports a counter that disagrees with its ledger rather than repairing it", async () => {
      const w = await freshWorkspace("reports-a-counter-that-disag");
      const cycle = await openUsageCycle(db(), w, NOW);
      await recordUsage(db(), { workspaceId: w, metric: "AI_GENERATION_CYCLES", usageOperationId: operation("drifted"), amount: 1, at: NOW });

      // A counter moved without a ledger row behind it, which is what a bug in this store would look like.
      await db().$executeRaw`
        UPDATE "usage_counters" SET "committed" = "committed" + 7
        WHERE "workspace_id" = ${w} AND "cycle_id" = ${cycle.id} AND "metric" = 'AI_GENERATION_CYCLES'`;

      const differences = await reconcileUsageCounters(db(), w, cycle.id);

      // Reported, not healed: a counter that repaired itself would hide the bug that broke it.
      const difference = differences.find((entry) => entry.metric === "AI_GENERATION_CYCLES");
      expect(difference).toBeDefined();
      expect(difference?.counter.committed).toBe((difference?.ledger.committed ?? 0) + 7);
      await db().$executeRaw`
        UPDATE "usage_counters" SET "committed" = "committed" - 7
        WHERE "workspace_id" = ${w} AND "cycle_id" = ${cycle.id} AND "metric" = 'AI_GENERATION_CYCLES'`;
    }, 300_000);

    it("reconstructs a cycle's totals from the ledger alone", async () => {
      const w = await freshWorkspace("reconstructs-a-cycle-s-total");
      const cycle = await openUsageCycle(db(), w, NOW);
      const usageOperationId = operation("reconstructable");
      await reserveUsage(db(), { workspaceId: w, metric: "VOICE_TRANSCRIPTION_SECONDS", usageOperationId, amount: 30, at: NOW });
      await commitReservation(db(), { workspaceId: w, metric: "VOICE_TRANSCRIPTION_SECONDS", usageOperationId, amount: 25, at: NOW });

      const sums = await db().usageLedgerEntry.groupBy({
        by: ["metric"],
        where: { workspaceId: w, cycleId: cycle.id, metric: "VOICE_TRANSCRIPTION_SECONDS" },
        _sum: { committedDelta: true, reservedDelta: true },
      });

      // Two column sums, no replay of a state machine: every row carries both deltas, which is what makes
      // the ledger the record of truth rather than a log beside one.
      expect(sums[0]?._sum.committedDelta).toBe(25);
      expect(sums[0]?._sum.reservedDelta).toBe(0);
    }, 300_000);
  });

});
