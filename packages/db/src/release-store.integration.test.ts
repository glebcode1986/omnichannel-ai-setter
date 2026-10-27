/**
 * Release candidates, their gate verdicts and who reviewed which commit (#60, LAUNCH_READINESS.md).
 *
 * The cases that matter are all about a mistake this design can actually make rather than one it might:
 *
 * - a verdict left on an older commit must not count for a newer one;
 * - a candidate nobody has reviewed must not move the product into a stage that lets profiles send
 *   unattended;
 * - **and a pile of such candidates must not do it either** — the window this is read through is small,
 *   and a window that found nothing used to report "no staged rollout", which is the *permissive* answer.
 *   Recording evidence would have switched the gate off;
 * - a sealed record's verdict must not be changeable by *appending* to it, which immutability alone does
 *   not prevent;
 * - and nothing here may be written by somebody who does not hold the permission for it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PlatformAccessDeniedError } from "./errors";
import { DbInputError } from "./errors";
import type { DbClient, DbExecutor } from "./client";
import { authorizePlatformAccess, type PlatformContext } from "./platform-tenancy";
import {
  listReleases,
  readRelease,
  readReleaseInForce,
  readRolloutAccess,
  recordRelease,
  recordReleaseReview,
  rolloutAccessFrom,
  setRolloutAutopilot,
} from "./release-store";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { createTestUser, seedWorkspace } from "./testing/fixtures";
import { RELEASE_GATES, type GateResult, type RolloutStage } from "@omnichannel/domain";

// In the past, and that is a constraint rather than a convention: a verdict may not be submitted in the
// future, so a suite stamping its fixtures with a date after the wall clock would be a suite that starts
// failing on its own fixtures. The window case below reaches further back still, so that reading "as of
// NOW" sees it.
const NOW = new Date("2026-10-01T12:00:00.000Z");
const LATER = new Date("2026-10-02T13:00:00.000Z");
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

/** Every gate passing with evidence, which each case then spoils in exactly one way. */
const allPassing = (overrides: readonly GateResult[] = []): GateResult[] => {
  const byGate = new Map(overrides.map((result) => [result.gateId, result]));
  return RELEASE_GATES.map((gate) => byGate.get(gate.id) ?? { gateId: gate.id, severity: "PASS", evidence: `run 1 covered ${gate.id}` });
};

describe.skipIf(!databaseTestsEnabled())("release records (PostgreSQL)", () => {
  let database: TestDatabase;
  let operations: PlatformContext;
  let support: PlatformContext;
  let tenant: Awaited<ReturnType<typeof seedWorkspace>>;
  const db = () => database.db;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    tenant = await seedWorkspace(database.db, "release");
    operations = await member("release-operator", "OPERATIONS");
    support = await member("release-supporter", "SUPPORT");
  }, 180_000);

  afterAll(async () => {
    await database?.dispose();
  });

  async function member(label: string, role: "OPERATIONS" | "SUPPORT"): Promise<PlatformContext> {
    const userId = await createTestUser(database.db, label);
    await database.db.platformMember.create({ data: { userId, role, note: `${label} rota` } });
    return authorizePlatformAccess(database.db, userId);
  }

  const record = (sha: string, stage: RolloutStage, results = allPassing(), at = NOW) =>
    recordRelease(db(), operations, {
      sha,
      stage,
      rollbackPlan: "redeploy the previous tag",
      summary: `candidate ${sha.slice(0, 7)} at ${stage}`,
      results,
      at,
    });

  const pass = (sha: string, reviewer = "astra", submittedAt = NOW) =>
    recordReleaseReview(db(), operations, { reviewer, verdict: "PASS", reviewedSha: sha, submittedAt });

  describe("recording a candidate", () => {
    it("stores the evidence and reports the decision it adds up to", async () => {
      const recorded = await record(SHA_A, "COMMERCIAL_BETA");

      expect(recorded.sha).toBe(SHA_A);
      expect(recorded.decision).toMatchObject({ releasable: true, blockers: [] });
      const view = await readRelease(db(), SHA_A);
      expect(view?.results.length).toBe(20);
      expect(view?.reviewer).toBe("NOT_REVIEWED");
      expect(view?.approved).toBe(false);
    }, 180_000);

    it("records a candidate that fails its own gates, because that is the point of a record", async () => {
      const recorded = await record(SHA_B, "INTERNAL", allPassing([{ gateId: "MEDIA", severity: "BLOCKER", evidence: "duplicate send under retry" }]));

      expect(recorded.decision.releasable).toBe(false);
      expect(recorded.decision.blockers).toEqual([{ gateId: "MEDIA", refusal: "BLOCKER_GATE" }]);
    }, 180_000);

    it("refuses an abbreviated SHA, a gate it does not define and two verdicts for one gate", async () => {
      await expect(record("a3d27e3", "INTERNAL")).rejects.toThrow(DbInputError);
      await expect(record(SHA_C, "INTERNAL", [{ gateId: "VIBES", severity: "PASS", evidence: "felt right" }])).rejects.toThrow(/not release gates/u);
      await expect(
        record(SHA_C, "INTERNAL", [
          { gateId: "MEDIA", severity: "BLOCKER", evidence: "first run" },
          { gateId: "MEDIA", severity: "PASS", evidence: "second run" },
        ]),
      ).rejects.toThrow(/two verdicts for MEDIA/u);
    }, 180_000);

    it("refuses a rollback plan or a summary that is only whitespace, in the database as well as the code", async () => {
      // A tab is the case bare `btrim` lets through, and the CHECK is the half that holds for a row
      // written by hand. Both halves are exercised: the function's refusal, then the constraint's.
      await expect(
        recordRelease(db(), operations, { sha: SHA_C, stage: "INTERNAL", rollbackPlan: "\t", summary: "fine", results: [] }),
      ).rejects.toThrow(DbInputError);
      await expect(
        db().$executeRaw`
          INSERT INTO "release_records" ("id", "sha", "actor_user_id", "stage", "rollback_plan", "summary", "created_at")
          VALUES (gen_random_uuid()::text, ${"d".repeat(40)}, ${tenant.ownerUserId}, 'INTERNAL', E'\t', 'fine', now())`,
      ).rejects.toThrow(/release_records_shape_check/u);
    }, 180_000);

    it("refuses the same commit at the same stage twice, with a sentence rather than an index name", async () => {
      // The mistake an operator actually makes: re-running the release script.
      await expect(record(SHA_A, "COMMERCIAL_BETA")).rejects.toThrow(/already recorded at COMMERCIAL_BETA/u);
    }, 180_000);

    it("lets one commit be proposed at a second stage, because §18 is a progression", async () => {
      const advanced = await record(SHA_A, "GENERAL_AVAILABILITY", allPassing(), LATER);

      expect(advanced.stage).toBe("GENERAL_AVAILABILITY");
      // And the verdict already given about that commit carries over, because a verdict is about code.
      await pass(SHA_A);
      expect((await readRelease(db(), SHA_A, "GENERAL_AVAILABILITY"))?.reviewer).toBe("PASS");
      expect((await readRelease(db(), SHA_A, "COMMERCIAL_BETA"))?.reviewer).toBe("PASS");
    }, 180_000);

    it("writes a WARNING audit row naming what it did, and no evidence strings", async () => {
      const rows = await db().platformAuditEvent.findMany({ where: { kind: "RELEASE_RECORDED" }, select: { severity: true, detail: true, reason: true } });

      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.severity === "WARNING")).toBe(true);
      // The row says what happened; the record holds what was run. A second copy of the evidence here
      // would be a second thing to keep in step.
      expect(JSON.stringify(rows)).not.toContain("run 1 covered");
    }, 180_000);

    it("refuses a role that does not hold the permission, and one that is not staff at all", async () => {
      await expect(
        recordRelease(db(), support, { sha: SHA_C, stage: "INTERNAL", rollbackPlan: "redeploy", summary: "from support", results: [] }),
      ).rejects.toThrow(/OPERATE_RELEASE|record a release candidate/u);
      await expect(authorizePlatformAccess(db(), await createTestUser(db(), "release-outsider"))).rejects.toThrow(PlatformAccessDeniedError);
    }, 180_000);
  });

  describe("what a sealed record can still be made to say", () => {
    it("refuses a gate result appended after the candidate was recorded", async () => {
      // The hole immutability alone leaves open, and the sharpest one in the design: `releasable` is
      // derived from the child rows, so supplying a missing verdict later would make a record releasable
      // with nothing edited and no new SHA.
      const partial = await recordRelease(db(), operations, {
        sha: "e".repeat(40),
        stage: "INTERNAL",
        rollbackPlan: "redeploy the previous tag",
        summary: "nineteen of twenty",
        results: allPassing().filter((result) => result.gateId !== "MEDIA"),
      });
      expect(partial.decision.blockers).toEqual([{ gateId: "MEDIA", refusal: "GATE_NOT_EVALUATED" }]);

      await expect(
        db().releaseGateResult.create({ data: { releaseId: partial.releaseId, gateId: "MEDIA", severity: "PASS", evidence: "ran it later" } }),
      ).rejects.toThrow(/written with the release candidate/u);
      expect((await readRelease(db(), "e".repeat(40)))?.decision.releasable).toBe(false);
    }, 180_000);

    it("refuses an update, a delete and a truncate of all three tables", async () => {
      // Its own rows, because a row trigger does not fire for a statement that matches nothing: asserting
      // against an empty table would be asserting that nothing happened.
      await record("3".repeat(40), "INTERNAL");
      await pass("3".repeat(40), "astra-append-only");
      expect(await db().releaseGateResult.count()).toBeGreaterThan(0);
      expect(await db().releaseReview.count()).toBeGreaterThan(0);

      await expect(db().$executeRaw`UPDATE "release_records" SET "summary" = 'edited'`).rejects.toThrow(/append-only/u);
      await expect(db().$executeRaw`DELETE FROM "release_gate_results"`).rejects.toThrow(/append-only/u);
      await expect(db().$executeRaw`UPDATE "release_reviews" SET "verdict" = 'PASS'`).rejects.toThrow(/append-only/u);
      // A row trigger never fires for TRUNCATE, and naming every referencing table in one statement
      // satisfies the foreign keys. Without the statement-level trigger this would succeed — and an
      // empty catalogue is the one state in which the §18 gate permits everybody.
      await expect(db().$executeRaw`TRUNCATE "release_reviews", "release_gate_results", "release_records"`).rejects.toThrow(/cannot be truncated/u);
    }, 180_000);

    it("refuses a verdict submitted in the future, which nothing could ever withdraw", async () => {
      // `reviewerStatusOf` takes the newest matching verdict, so a PASS stamped 2099 would outrank every
      // genuine CHANGES_REQUESTED after it — in a table where no row can be edited or deleted.
      await expect(pass(SHA_A, "astra-from-the-future", new Date("2099-01-01T00:00:00.000Z"))).rejects.toThrow(/cannot be submitted in the future/u);
    }, 180_000);
  });

  describe("which verdict counts", () => {
    it("ignores a PASS given to another commit, however recent", async () => {
      await record(SHA_C, "COMMERCIAL_BETA");
      await pass(SHA_B, "astra", LATER);

      const view = await readRelease(db(), SHA_C, "COMMERCIAL_BETA");
      expect(view?.reviewer).toBe("NOT_REVIEWED");
      expect(view?.approved).toBe(false);
    }, 180_000);

    it("reports zero candidates for a verdict about a commit nobody proposed, rather than refusing it", async () => {
      const filed = await recordReleaseReview(db(), operations, {
        reviewer: "astra",
        verdict: "PASS",
        reviewedSha: "f".repeat(40),
        submittedAt: NOW,
      });

      expect(filed.candidates).toBe(0);
    }, 180_000);

    it("takes the newest verdict, and the refusal when two arrive in the same instant", async () => {
      await recordReleaseReview(db(), operations, { reviewer: "astra", verdict: "PASS", reviewedSha: SHA_C, submittedAt: NOW });
      expect((await readRelease(db(), SHA_C, "COMMERCIAL_BETA"))?.reviewer).toBe("PASS");

      await recordReleaseReview(db(), operations, { reviewer: "codex", verdict: "CHANGES_REQUESTED", reviewedSha: SHA_C, submittedAt: NOW });
      // A tie decided by insertion order would make this answer a property of the query plan, and it is
      // recomputed on every send. It is decided against the release instead.
      expect((await readRelease(db(), SHA_C, "COMMERCIAL_BETA"))?.reviewer).toBe("CHANGES_REQUESTED");
    }, 180_000);
  });

  describe("the stage in force", () => {
    it("is nothing at all on a deployment that has recorded no release", async () => {
      const empty = await createMigratedTestDatabase();
      try {
        expect(await readReleaseInForce(empty.db, NOW)).toEqual({ kind: "NONE" });
        // And nothing in force permits, because there is no stage to enforce.
        expect(rolloutAccessFrom({ kind: "NONE" }, false)).toEqual({ autopilot: true });
      } finally {
        await empty.dispose();
      }
    }, 180_000);

    it("is the newest approved candidate, and ignores the unapproved ones above it", async () => {
      const inForce = await readReleaseInForce(db(), LATER);

      expect(inForce.kind).toBe("IN_FORCE");
      expect(inForce.kind === "IN_FORCE" ? inForce.stage : undefined).toBe("GENERAL_AVAILABILITY");
    }, 180_000);

    it("refuses rather than permits when the window is full of unapproved proposals", async () => {
      // The defect this case exists for: ten unreviewed candidates — the single most common state a
      // candidate is in — used to push the live release out of the window, and an exhausted window
      // reported "no staged rollout", which permits everybody. Recording evidence turned the gate off.
      const fresh = await createMigratedTestDatabase();
      try {
        const operator = await createTestUser(fresh.db, "window-operator");
        await fresh.db.platformMember.create({ data: { userId: operator, role: "OPERATIONS", note: "window rota" } });
        const context = await authorizePlatformAccess(fresh.db, operator);
        const live = "1".repeat(40);
        await recordRelease(fresh.db, context, {
          sha: live,
          stage: "LIMITED_AUTOPILOT",
          rollbackPlan: "redeploy",
          summary: "the live one",
          results: allPassing(),
          at: new Date("2026-09-01T00:00:00.000Z"),
        });
        await recordReleaseReview(fresh.db, context, {
          reviewer: "astra",
          verdict: "PASS",
          reviewedSha: live,
          submittedAt: new Date("2026-09-01T01:00:00.000Z"),
        });
        expect((await readReleaseInForce(fresh.db, NOW)).kind).toBe("IN_FORCE");

        for (let index = 0; index < 11; index += 1) {
          await recordRelease(fresh.db, context, {
            sha: `${index}`.padStart(40, "9"),
            stage: "GENERAL_AVAILABILITY",
            rollbackPlan: "redeploy",
            summary: `proposal ${index}`,
            results: allPassing(),
            at: new Date(`2026-09-0${2 + (index % 7)}T0${index % 10}:00:00.000Z`),
          });
        }

        const buried = await readReleaseInForce(fresh.db, NOW);
        expect(buried.kind).toBe("INDETERMINATE");
        // And the refusal reaches the policy engine as a refusal, not as "no rollout".
        expect(rolloutAccessFrom(buried, true)).toEqual({ autopilot: false });
      } finally {
        await fresh.dispose();
      }
    }, 180_000);

    it("keeps AUTOPILOT off when the release's own gates switched it off, whatever stage it names", async () => {
      // `HIGH` is deliberately not a blocker — the spec's rule is that the release goes out with the
      // affected capability disabled. Something has to be the thing that keeps it off.
      const fresh = await createMigratedTestDatabase();
      try {
        const operator = await createTestUser(fresh.db, "high-operator");
        await fresh.db.platformMember.create({ data: { userId: operator, role: "OPERATIONS", note: "high rota" } });
        const context = await authorizePlatformAccess(fresh.db, operator);
        const sha = "2".repeat(40);
        const recorded = await recordRelease(fresh.db, context, {
          sha,
          stage: "GENERAL_AVAILABILITY",
          rollbackPlan: "redeploy",
          summary: "headless cycle unverified",
          results: allPassing([{ gateId: "AUTOPILOT_HEADLESS", severity: "HIGH", evidence: "no staging deployment to observe it on" }]),
          at: NOW,
        });
        await recordReleaseReview(fresh.db, context, { reviewer: "astra", verdict: "PASS", reviewedSha: sha, submittedAt: NOW });

        expect(recorded.decision.releasable).toBe(true);
        expect(recorded.decision.disabledCapabilities).toEqual(["AUTOPILOT"]);
        const inForce = await readReleaseInForce(fresh.db, NOW);
        expect(inForce.kind === "IN_FORCE" ? inForce.disabledCapabilities : undefined).toEqual(["AUTOPILOT"]);
        // GENERAL_AVAILABILITY would permit it. The release's own evidence does not.
        expect(rolloutAccessFrom(inForce, true)).toEqual({ autopilot: false });
      } finally {
        await fresh.dispose();
      }
    }, 180_000);

    it("does not see a release recorded after the instant it was asked about", async () => {
      // The claim re-resolves at `claimedAt`, and a catalogue read at the wall clock would describe a
      // different moment from every other fact in the guard.
      const before = await readReleaseInForce(db(), new Date("2026-08-01T00:00:00.000Z"));

      expect(before).toEqual({ kind: "NONE" });
    }, 180_000);
  });

  describe("the limited-rollout allowlist", () => {
    it("is off until somebody selects the profile, and selecting it is audited", async () => {
      const target = { workspaceId: tenant.workspaceId, businessProfileId: tenant.profiles[0]?.businessProfileId ?? "" };

      expect(await readRolloutAccess(db(), target, LATER)).toEqual({ autopilot: true });
      const first = await setRolloutAutopilot(db(), operations, { ...target, enabled: true, reason: "design partner, agreed in writing" });
      const second = await setRolloutAutopilot(db(), operations, { ...target, enabled: true, reason: "clicked twice" });

      expect(first.changed).toBe(true);
      // A no-op writes no row: the audit should say what happened, and nothing happened.
      expect(second.changed).toBe(false);
      const rows = await db().platformAuditEvent.findMany({ where: { kind: "ROLLOUT_ALLOWLIST_CHANGED" }, select: { severity: true } });
      expect(rows).toEqual([{ severity: "WARNING" }]);
    }, 180_000);

    /**
     * Holds every transaction at its first read of the Business Profile until all of them have read.
     *
     * The interleaving is forced rather than waited for: a `sleep` would be a guess, and a sequential
     * double click — which the case above is — never produces it at all. Two real transactions against
     * real PostgreSQL; the proxy forwards every call untouched and only chooses *when* they are released.
     */
    function heldAtFirstProfileRead(parties: number): DbClient {
      let arrived = 0;
      let open = () => {};
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      const wait = async () => {
        arrived += 1;
        if (arrived >= parties) {
          open();
        }
        await gate;
      };
      return new Proxy(db(), {
        get(client, property, receiver) {
          if (property !== "$transaction") {
            return Reflect.get(client, property, receiver) as unknown;
          }
          return (callback: (tx: DbExecutor) => Promise<unknown>, ...rest: readonly unknown[]) =>
            client.$transaction(
              (tx) =>
                callback(
                  new Proxy(tx, {
                    get(inner, model, innerReceiver) {
                      const delegate = Reflect.get(inner, model, innerReceiver) as unknown;
                      if (model !== "businessProfile") {
                        return delegate;
                      }
                      return new Proxy(delegate as object, {
                        get(owner, call, ownerReceiver) {
                          const original = Reflect.get(owner, call, ownerReceiver) as unknown;
                          if (call !== "findUnique" || typeof original !== "function") {
                            return original;
                          }
                          return async (...args: unknown[]) => {
                            const row = await (original as (...a: unknown[]) => Promise<unknown>).apply(owner, args);
                            await wait();
                            return row;
                          };
                        },
                      });
                    },
                  }),
                ),
              ...(rest as []),
            );
        },
      });
    }

    it("lets exactly one of two concurrent selections report the transition, in both directions", async () => {
      // Astra's P2 on PR #103, and the third time this class has appeared: the read decided, an
      // unconditional `update` followed, and the audit row was written whatever the update did. Two
      // operators adding the same profile both saw `false`, both returned `changed: true`, and both filed
      // `ROLLOUT_ALLOWLIST_CHANGED` — while only one `false -> true` had happened. The flag ends up right
      // either way; the record did not.
      //
      // Its own workspace, so the unscoped audit count in the case above keeps meaning what it says.
      const own = await seedWorkspace(db(), "allowlist-race");
      // A second operator, because one actor pressing twice is the sequential case above.
      const rival = await member("allowlist-rival", "OPERATIONS");
      const target = { workspaceId: own.workspaceId, businessProfileId: own.profiles[0]?.businessProfileId ?? "" };
      const audited = async () =>
        db().platformAuditEvent.count({ where: { kind: "ROLLOUT_ALLOWLIST_CHANGED", businessProfileId: target.businessProfileId } });

      const adding = heldAtFirstProfileRead(2);
      const added = await Promise.all([
        setRolloutAutopilot(adding, operations, { ...target, enabled: true, reason: "first operator" }),
        setRolloutAutopilot(adding, rival, { ...target, enabled: true, reason: "second operator" }),
      ]);

      expect(added.filter((result) => result.changed).length).toBe(1);
      expect(await audited()).toBe(1);
      // The flag itself, not `readRolloutAccess`: with no release in force the catalogue permits
      // unattended sending whatever the allowlist says, so that reader cannot tell these two apart.
      const selected = await db().businessProfile.findUniqueOrThrow({
        where: { workspaceId_id: { workspaceId: target.workspaceId, id: target.businessProfileId } },
        select: { rolloutAutopilot: true },
      });
      expect(selected.rolloutAutopilot).toBe(true);

      // The other direction, because a guard that only held one way would pass the half above.
      const removing = heldAtFirstProfileRead(2);
      const removed = await Promise.all([
        setRolloutAutopilot(removing, operations, { ...target, enabled: false, reason: "first operator" }),
        setRolloutAutopilot(removing, rival, { ...target, enabled: false, reason: "second operator" }),
      ]);

      expect(removed.filter((result) => result.changed).length).toBe(1);
      expect(await audited()).toBe(2);
      const deselected = await db().businessProfile.findUniqueOrThrow({
        where: { workspaceId_id: { workspaceId: target.workspaceId, id: target.businessProfileId } },
        select: { rolloutAutopilot: true },
      });
      expect(deselected.rolloutAutopilot).toBe(false);
    }, 180_000);

    it("cannot be changed by a role without the permission, or for a profile in another workspace", async () => {
      const target = { workspaceId: tenant.workspaceId, businessProfileId: tenant.profiles[0]?.businessProfileId ?? "" };

      await expect(setRolloutAutopilot(db(), support, { ...target, enabled: false, reason: "support tried" })).rejects.toThrow(
        /OPERATE_RELEASE|allowlist/u,
      );
      await expect(
        setRolloutAutopilot(db(), operations, { workspaceId: tenant.workspaceId, businessProfileId: "bp-nowhere", enabled: true, reason: "typo" }),
      ).rejects.toThrow(DbInputError);
    }, 180_000);

    it("matters only at the stage that names it", () => {
      // Before LIMITED_AUTOPILOT nobody autopilots whatever the list says; from COMMERCIAL_BETA the plan
      // governs and the list is spent. Asserted as the whole table, so a stage quietly changing meaning
      // is a failing test.
      const answers = (["INTERNAL", "DESIGN_PARTNERS_DRAFT", "LIMITED_AUTOPILOT", "COMMERCIAL_BETA", "GENERAL_AVAILABILITY"] as const).map((stage) => [
        stage,
        rolloutAccessFrom({ kind: "IN_FORCE", stage, disabledCapabilities: [], sha: SHA_A }, false).autopilot,
        rolloutAccessFrom({ kind: "IN_FORCE", stage, disabledCapabilities: [], sha: SHA_A }, true).autopilot,
      ]);

      expect(answers).toEqual([
        ["INTERNAL", false, false],
        ["DESIGN_PARTNERS_DRAFT", false, false],
        ["LIMITED_AUTOPILOT", false, true],
        ["COMMERCIAL_BETA", true, true],
        ["GENERAL_AVAILABILITY", true, true],
      ]);
    }, 180_000);
  });

  describe("reading back a catalogue", () => {
    it("lists candidates newest first and holds every stored gate id against the domain's catalogue", async () => {
      const listed = await listReleases(db(), 20);

      expect(listed.length).toBeGreaterThan(3);
      const times = listed.map((view) => view.createdAt.getTime());
      expect(times).toEqual([...times].toSorted((left, right) => right - left));
      // The promise the schema comment makes about `gate_id` being free text rather than a foreign key.
      const storedIds = new Set(listed.flatMap((view) => view.results.map((result) => result.gateId)));
      expect([...storedIds].filter((id) => !RELEASE_GATES.some((gate) => gate.id === id))).toEqual([]);
    }, 180_000);
  });
});
