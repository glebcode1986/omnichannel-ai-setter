/**
 * Automation settings, against a real server (Issue #30).
 *
 * The cases that matter are the ones where a careless implementation is silently wrong: a preset that
 * quietly dropped a mandatory-review topic, a save that changed nothing but left an audit row saying
 * somebody did something, and an audit that did not get written because it was a second statement.
 */
import { MANDATORY_REVIEW_REASON_CODES } from "@omnichannel/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WorkspacePermissionError } from "./errors";
import { listPolicyAudits, readPolicies, savePolicy, type PolicyEdit } from "./policy-store";
import { authorizeBusinessProfileAccess } from "./tenancy";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { addTestMember, createTestUser, seedWorkspace, type SeededProfile, type SeededWorkspace } from "./testing/fixtures";

describe.skipIf(!databaseTestsEnabled())("automation settings", () => {
  let database: TestDatabase;
  let workspace: SeededWorkspace;
  let profile: SeededProfile;
  let neighbour: SeededWorkspace;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    workspace = await seedWorkspace(database.db, "policy");
    [profile] = workspace.profiles as [SeededProfile];
    neighbour = await seedWorkspace(database.db, "policy-neighbour");
  }, 180_000);

  afterAll(async () => {
    await database?.dispose();
  });

  const db = () => database.db;
  const scope = () => ({ workspaceId: profile.context.workspaceId, businessProfileId: profile.businessProfileId });

  /** The Business Profile default, created if the seed did not make one. */
  const ensureDefault = async () => {
    const existing = await db().automationPolicy.findFirst({ where: { ...scope(), channelAccountId: null }, select: { id: true } });
    if (existing === null) {
      await db().automationPolicy.create({ data: { ...scope(), mandatoryReviewReasons: [...MANDATORY_REVIEW_REASON_CODES] } });
    }
  };

  const theDefault = async () => (await readPolicies(db(), profile.context)).find((policy) => policy.channelAccountId === null);

  /**
   * Resolves once a backend is observably blocked waiting for `xid` to end — which is how this suite knows
   * a concurrent save has reached its `SELECT … FOR UPDATE` and is parked there.
   *
   * Asking the database for the state the barrier depends on, rather than sleeping and hoping. A
   * `setTimeout` is a guess about how the host scheduled two connections, and under a full parallel suite
   * the guess is sometimes wrong: the hold is released before the save reaches its lock, and the case then
   * reports a lost update that is really a race inside the test. In the one regression that distinguishes a
   * real row lock from a version check reading stale data, a flake is worse than no case at all — it
   * teaches whoever next sees it red to re-run rather than look.
   *
   * Keyed to the **holding transaction's own id**, not to "some lock is ungranted anywhere". A blocked
   * `FOR UPDATE` waits on a `transactionid` lock for the holder, so that is the precise fact; counting
   * every ungranted lock in the database would be satisfied by an unrelated suite's contention and would
   * reintroduce exactly the race this replaces. `pg_current_xact_id()::xid` narrows the 64-bit id to the
   * 32-bit form `pg_locks` reports.
   *
   * Bounded, and it throws rather than returning: a barrier that never formed must fail loudly instead of
   * letting the case pass for the wrong reason.
   */
  const waitForBackendBlockedOn = async (xid: string, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [blocked] = await db().$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count
        FROM pg_locks
        WHERE NOT granted AND locktype = 'transactionid' AND transactionid = ${xid}::xid`;
      if ((blocked?.count ?? 0n) > 0n) {
        return;
      }
      if (Date.now() > deadline) {
        throw new Error(`no backend ever blocked on transaction ${xid}: the barrier never formed`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  /**
   * Saves against the stored version, which is what the screen does: it renders the version it read and
   * posts that version back. Spelling it out in every case below would bury the behaviour each case is
   * about — so the cases where the version *is* the subject call `savePolicy` directly instead.
   */
  const save = async (edit: Omit<PolicyEdit, "expectedVersion">, context = profile.context) => {
    const current = (await readPolicies(db(), context)).find((policy) => policy.channelAccountId === null);
    return savePolicy(db(), context, null, { ...edit, expectedVersion: current?.version ?? 1 });
  };

  beforeAll(ensureDefault, 60_000);

  describe("presets", () => {
    it("writes the values a preset name means, never values a caller sent", async () => {
      const outcome = await save({ confidencePreset: "CONSERVATIVE" });

      expect(outcome.status).toBe("SAVED");
      const policy = await theDefault();
      // 0.9 comes from the domain. A caller cannot ask for a threshold by naming a preset.
      expect(policy?.confidenceThreshold).toBe(0.9);
      expect(policy?.confidencePreset).toBe("CONSERVATIVE");
      expect(policy?.mandatoryReviewReasons).toContain("LOW_CONFIDENCE");
    }, 180_000);

    it("keeps every mandatory-review topic however permissive the preset", async () => {
      await save({ confidencePreset: "AGGRESSIVE" });

      const policy = await theDefault();
      for (const reason of MANDATORY_REVIEW_REASON_CODES) {
        expect(policy?.mandatoryReviewReasons, `AGGRESSIVE dropped ${reason}`).toContain(reason);
      }
    }, 180_000);

    it("cannot be told to drop a mandatory-review topic by hand either", async () => {
      // The domain re-adds the floor whatever the caller asked for, so this store cannot write a policy
      // that lets a payment dispute answer itself — and neither can anything built on it.
      await save({ confidence: { confidenceThreshold: 0.7, mandatoryReviewReasons: ["LOW_CONFIDENCE"] } });

      const policy = await theDefault();
      expect(policy?.mandatoryReviewReasons).toContain("PAYMENT_DISPUTE");
      expect(policy?.confidenceThreshold).toBe(0.7);
    }, 180_000);

    it("writes timing as the preset's ranges", async () => {
      await save({ timingPreset: "FAST" });

      const policy = await theDefault();
      expect(policy?.timingPreset).toBe("FAST");
      expect(policy?.deliveryDelayMs.maxMs).toBeLessThan(120_000);
    }, 180_000);

    it("reports a hand-tuned policy as custom rather than naming a preset", async () => {
      await save({
        timing: { debounceWindowMs: { minMs: 1_000, maxMs: 2_000 }, deliveryDelayMs: { minMs: 4_000, maxMs: 9_000 } },
      });

      expect((await theDefault())?.timingPreset).toBe("CUSTOM");
    }, 180_000);

    it("refuses a request that names a preset and exact values at once", async () => {
      // Two answers to one question; whichever won would be an accident of ordering.
      expect(
        await save({
          confidencePreset: "BALANCED",
          confidence: { confidenceThreshold: 0.5, mandatoryReviewReasons: [] },
        }),
      ).toEqual({ status: "REFUSED", reason: "choose a preset or exact values, not both" });
    }, 180_000);
  });

    it("refuses a request that names a timing preset and exact ranges at once", async () => {
      expect(
        await save({
          timingPreset: "FAST",
          timing: { debounceWindowMs: { minMs: 1_000, maxMs: 2_000 }, deliveryDelayMs: { minMs: 3_000, maxMs: 4_000 } },
        }),
      ).toEqual({ status: "REFUSED", reason: "choose a timing preset or exact values, not both" });
    }, 180_000);

    it("refuses a custom range whose bounds are the wrong way round", async () => {
      const outcome = await save({
        timingPreset: "CUSTOM",
        timing: { debounceWindowMs: { minMs: 9_000, maxMs: 2_000 }, deliveryDelayMs: { minMs: 6_000, maxMs: 11_000 } },
      });

      // The domain's refusal, named by field. A store that accepted it would write a window the scheduler
      // cannot draw a delay from, and the first reply after the save would be the one to find out.
      expect(outcome.status).toBe("REFUSED");
      expect(outcome.status === "REFUSED" ? outcome.reason : "").toContain("minMs must not exceed maxMs");
    }, 180_000);

    it("refuses a negative custom bound, and writes nothing", async () => {
      const before = await theDefault();

      const outcome = await save({
        timingPreset: "CUSTOM",
        timing: { debounceWindowMs: { minMs: -1_000, maxMs: 2_000 }, deliveryDelayMs: { minMs: 6_000, maxMs: 11_000 } },
      });

      expect(outcome.status).toBe("REFUSED");
      expect((await theDefault())?.debounceWindowMs).toEqual(before?.debounceWindowMs);
      expect((await theDefault())?.version).toBe(before?.version);
    }, 180_000);

    it("persists a custom range and reads it back as the same four numbers", async () => {
      await save({
        timingPreset: "CUSTOM",
        timing: { debounceWindowMs: { minMs: 3_000, maxMs: 9_000 }, deliveryDelayMs: { minMs: 20_000, maxMs: 45_000 } },
      });

      // Read back through `readPolicies` rather than from the write's return value: the owner's next page
      // load is what has to show their numbers, and that is a different query.
      const reread = (await readPolicies(db(), profile.context)).find((policy) => policy.channelAccountId === null);
      expect(reread?.debounceWindowMs).toEqual({ minMs: 3_000, maxMs: 9_000 });
      expect(reread?.deliveryDelayMs).toEqual({ minMs: 20_000, maxMs: 45_000 });
      expect(reread?.timingPreset).toBe("CUSTOM");
    }, 180_000);

    it("accepts CUSTOM alongside exact ranges, because that is what CUSTOM means", async () => {
      // The guard is about a *named* preset contradicting values. `CUSTOM` names no values, so it agrees
      // with them rather than competing.
      const outcome = await save({
        timingPreset: "CUSTOM",
        timing: { debounceWindowMs: { minMs: 2_000, maxMs: 5_000 }, deliveryDelayMs: { minMs: 6_000, maxMs: 11_000 } },
      });

      expect(outcome.status).toBe("SAVED");
      const policy = await theDefault();
      expect(policy?.debounceWindowMs).toEqual({ minMs: 2_000, maxMs: 5_000 });
      expect(policy?.timingPreset).toBe("CUSTOM");
    }, 180_000);

  describe("the audit trail", () => {
    it("records who changed what, with the values on both sides", async () => {
      await save({ confidencePreset: "BALANCED", mode: "DRAFT" });
      const before = (await theDefault())?.confidenceThreshold;

      await save({ confidencePreset: "AGGRESSIVE" });

      const [latest] = (await listPolicyAudits(db(), profile.context)).entries;
      expect(latest?.actorName).toBe("Test policy-owner");
      expect((latest?.before as { confidenceThreshold: number }).confidenceThreshold).toBe(before);
      expect((latest?.after as { confidenceThreshold: number }).confidenceThreshold).toBe(0.65);
      expect(latest?.impacts).toContain("CONFIDENCE_LOWERED");
    }, 180_000);

    it("names turning on autopilot as an impact", async () => {
      await save({ mode: "DRAFT" });

      await save({ mode: "AUTOPILOT" });

      expect((await listPolicyAudits(db(), profile.context)).entries[0]?.impacts).toContain("AUTOPILOT_ENABLED");
    }, 180_000);

    it("writes no audit row for a save that changed nothing", async () => {
      await save({ confidencePreset: "BALANCED" });
      const countBefore = (await listPolicyAudits(db(), profile.context)).entries.length;

      const outcome = await save({ confidencePreset: "BALANCED" });

      // A history where every click is an entry is a history nobody reads.
      expect(outcome).toEqual({ status: "UNCHANGED" });
      expect((await listPolicyAudits(db(), profile.context)).entries.length).toBe(countBefore);
    }, 180_000);

    it("records a change with no visible effect, with no impacts", async () => {
      await save({ businessGoal: "Book appointments" });

      const [latest] = (await listPolicyAudits(db(), profile.context)).entries;
      // "Did anyone touch this?" has a useful answer, and `impacts` says it widened nothing.
      expect(latest?.impacts).toEqual([]);
      expect((latest?.after as { businessGoal: string }).businessGoal).toBe("Book appointments");
    }, 180_000);

    it("reads newest first", async () => {
      await save({ businessGoal: "First goal" });
      await save({ businessGoal: "Second goal" });

      const audits = (await listPolicyAudits(db(), profile.context)).entries;
      expect((audits[0]?.after as { businessGoal: string }).businessGoal).toBe("Second goal");
    }, 180_000);

    it("never shows another Workspace's changes", async () => {
      const [theirProfile] = neighbour.profiles as [SeededProfile];
      await db().automationPolicy.create({
        data: {
          workspaceId: theirProfile.context.workspaceId,
          businessProfileId: theirProfile.businessProfileId,
          mandatoryReviewReasons: [...MANDATORY_REVIEW_REASON_CODES],
        },
      });
      await save({ businessGoal: "Their goal" }, theirProfile.context);

      const mine = (await listPolicyAudits(db(), profile.context)).entries;
      expect(mine.map((audit) => (audit.after as { businessGoal: string | null }).businessGoal)).not.toContain("Their goal");
    }, 180_000);
  });

  describe("the settings themselves", () => {
    it("stores the goal and the qualification criteria", async () => {
      await save({
        businessGoal: "  Book consultations  ",
        qualificationCriteria: ["  has a budget  ", "", "   ", "wants a date this month"],
      });

      const policy = await theDefault();
      // Trimmed, and blank lines dropped: a criterion the assistant cannot act on would show as a rule
      // with nothing on screen explaining why it does nothing.
      expect(policy?.businessGoal).toBe("Book consultations");
      expect(policy?.qualificationCriteria).toEqual(["has a budget", "wants a date this month"]);
    }, 180_000);

    it("treats a cleared goal as no goal", async () => {
      await save({ businessGoal: "Something" });

      await save({ businessGoal: "   " });

      expect((await theDefault())?.businessGoal).toBeNull();
    }, 180_000);

    it("stores the Instagram and WhatsApp after-window choices", async () => {
      await save({
        instagramAfterWindowPolicy: "HUMAN_ASSISTED_EXTENDED",
        whatsappAfterWindowPolicy: "TEMPLATE_AUTOPILOT",
        whatsappTemplateAutomationAllowlist: ["booking_reminder"],
      });

      const policy = await theDefault();
      expect(policy?.instagramAfterWindowPolicy).toBe("HUMAN_ASSISTED_EXTENDED");
      expect(policy?.whatsappAfterWindowPolicy).toBe("TEMPLATE_AUTOPILOT");
      expect(policy?.whatsappTemplateAutomationAllowlist).toEqual(["booking_reminder"]);
    }, 180_000);

    it("names template autopilot with an empty allowlist as its own impact", async () => {
      await save({ whatsappAfterWindowPolicy: "SERVICE_WINDOW_ONLY", whatsappTemplateAutomationAllowlist: [] });

      await save({ whatsappAfterWindowPolicy: "TEMPLATE_AUTOPILOT" });

      // ADR-016: enabled with nothing on the allowlist sends nothing, so it is a setting that looks on
      // and does nothing.
      const [latest] = (await listPolicyAudits(db(), profile.context)).entries;
      expect(latest?.impacts).toContain("TEMPLATE_AUTOPILOT_WITHOUT_ALLOWLIST");
    }, 180_000);

    it("refuses a blank allowlist entry, in the domain's own words", async () => {
      const outcome = await save({ whatsappTemplateAutomationAllowlist: ["ok", "  "] });

      // The domain's own message, which names the field. Asserted on the string rather than through a
      // matcher, so the reason an operator would see is what the test reads.
      expect(outcome.status).toBe("REFUSED");
      expect(outcome.status === "REFUSED" ? outcome.reason : "").toContain("non-empty");
    }, 180_000);

    it("refuses a mode nobody defined", async () => {
      expect((await save({ mode: "SEMI_AUTO" as never })).status).toBe("REFUSED");
    }, 180_000);
  });

  describe("who may change them", () => {
    /** A member of this very Workspace and profile, holding the role under test. */
    const memberContext = async (role: "OWNER" | "ADMIN" | "AGENT") => {
      const userId = await createTestUser(db(), `policy-${role.toLowerCase()}-${String(Date.now())}`);
      await addTestMember(db(), profile.context.workspaceId, userId, role, "ALL");
      return authorizeBusinessProfileAccess(db(), {
        userId,
        workspaceId: profile.context.workspaceId,
        businessProfileId: profile.businessProfileId,
      });
    };

    it("refuses an agent who may read the profile but not govern it", async () => {
      const agent = await memberContext("AGENT");
      const before = await theDefault();

      // A properly issued context for this very profile: the refusal is about the role, not the scope.
      // `ONBOARDING_UX.md` constrains policy changes by role exactly as it constrains connecting a
      // channel, and an agent switching the workspace to AUTOPILOT is the case it rules out.
      await expect(
        savePolicy(db(), agent, null, { mode: "AUTOPILOT", expectedVersion: before?.version ?? 1 }),
      ).rejects.toThrow(WorkspacePermissionError);

      const after = await theDefault();
      expect(after?.mode).toBe(before?.mode);
      expect(after?.version).toBe(before?.version);
    }, 180_000);

    it("refuses before it reads, so an agent cannot learn a version by being refused", async () => {
      const agent = await memberContext("AGENT");

      // The version named is wrong on purpose. A store that checked the row first would answer CONFLICT
      // here and SAVED for the right number, which tells a member without permission what the stored
      // version is and that the row exists.
      await expect(savePolicy(db(), agent, null, { mode: "DRAFT", expectedVersion: 9_999 })).rejects.toThrow(WorkspacePermissionError);
    }, 180_000);

    it("allows an owner and an admin", async () => {
      for (const role of ["OWNER", "ADMIN"] as const) {
        const context = await memberContext(role);
        const current = (await readPolicies(db(), context)).find((policy) => policy.channelAccountId === null);
        const outcome = await savePolicy(db(), context, null, { businessGoal: `goal from an ${role}`, expectedVersion: current?.version ?? 1 });

        expect(outcome.status, `${role} was refused`).toBe("SAVED");
      }
    }, 180_000);
  });

  describe("two tabs", () => {
    it("refuses the second save and hands back what is stored", async () => {
      await save({ businessGoal: "the original" });
      const shared = await theDefault();
      const staleVersion = shared?.version ?? 1;

      // Both tabs rendered the same version. The first save wins.
      const first = await savePolicy(db(), profile.context, null, { businessGoal: "the first tab's goal", expectedVersion: staleVersion });
      expect(first.status).toBe("SAVED");

      // The second posts its whole form from a snapshot that predates the first save. Without the
      // version this succeeded and reverted a change its author had never seen.
      const second = await savePolicy(db(), profile.context, null, { businessGoal: "the second tab's goal", expectedVersion: staleVersion });

      expect(second.status).toBe("CONFLICT");
      expect(second.status === "CONFLICT" ? second.current.businessGoal : undefined).toBe("the first tab's goal");
      expect(second.status === "CONFLICT" ? second.current.version : undefined).toBe(staleVersion + 1);
      // And nothing was written: not the values, and not an audit row claiming somebody changed them.
      expect((await theDefault())?.businessGoal).toBe("the first tab's goal");
      const [latest] = (await listPolicyAudits(db(), profile.context)).entries;
      expect((latest?.after as { businessGoal: string | null }).businessGoal).toBe("the first tab's goal");
    }, 180_000);

    it("does not lose a write that commits between the read and the update", async () => {
      await save({ businessGoal: "concurrent start" });
      const version = (await theDefault())?.version ?? 1;
      const policyId = (await theDefault())?.id ?? "";

      // A barrier, because `Promise.all` over two saves proves nothing: the two transactions may simply
      // run one after the other, and they do — removing the lock from the store leaves such a test
      // passing. This holds one writer open *across* the other's read instead.
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      // The holder announces its own transaction id, so the barrier below can wait for a backend blocked
      // on *this* transaction rather than on any contention in the database.
      let holderXid = "";
      let announced = () => {};
      const xidKnown = new Promise<void>((resolve) => {
        announced = resolve;
      });
      const other = db().$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "automation_policies" WHERE "id" = ${policyId} FOR UPDATE`;
          await tx.automationPolicy.update({
            where: { id: policyId },
            data: { businessGoal: "the other transaction wrote this", version: { increment: 1 } },
          });
          const [self] = await tx.$queryRaw<{ xid: string }[]>`SELECT pg_current_xact_id()::xid::text AS xid`;
          holderXid = self?.xid ?? "";
          announced();
          // Still uncommitted, and holding the row's lock. A reader that does not ask for the lock sees
          // the pre-transaction version here and concludes its own expectation is satisfied.
          await held;
        },
        { timeout: 60_000 },
      );
      await xidKnown;

      const saving = savePolicy(db(), profile.context, null, { businessGoal: "the stale writer's goal", expectedVersion: version });
      // The save is in position once a backend is blocked on the holder's transaction, which is a fact
      // about the database rather than an assumption about scheduling.
      await waitForBackendBlockedOn(holderXid);
      release();
      await other;
      const outcome = await saving;

      // CONFLICT, because by the time the lock was granted the stored version had moved. Without the
      // `FOR UPDATE` the read happened before the other commit, the version compared equal, and the
      // update overwrote a change that had already been committed — a lost update that no amount of
      // version *checking* catches, because the check itself was reading stale data.
      expect(outcome.status).toBe("CONFLICT");
      expect(outcome.status === "CONFLICT" ? outcome.current.businessGoal : undefined).toBe("the other transaction wrote this");
      expect((await theDefault())?.businessGoal).toBe("the other transaction wrote this");
      expect((await theDefault())?.version).toBe(version + 1);
    }, 180_000);

    it("counts a save that changed nothing as no version step", async () => {
      await save({ businessGoal: "idempotent" });
      const version = (await theDefault())?.version ?? 1;

      expect(await savePolicy(db(), profile.context, null, { businessGoal: "idempotent", expectedVersion: version })).toEqual({ status: "UNCHANGED" });

      // The form the owner is looking at stays valid: a no-op must not invalidate the open tab.
      expect((await theDefault())?.version).toBe(version);
    }, 180_000);

    it("moves the version by exactly one, so the next form is the next version", async () => {
      const version = (await theDefault())?.version ?? 1;

      const outcome = await savePolicy(db(), profile.context, null, { businessGoal: "moved the version", expectedVersion: version });

      expect(outcome.status).toBe("SAVED");
      // Read back rather than taken from the outcome: the screen re-reads the policy on its next render,
      // so that is the number it will actually render the form from.
      expect((await theDefault())?.version).toBe(version + 1);
    }, 180_000);
  });

  describe("reading the history in pages", () => {
    it("reaches an entry past the first page, and stops", async () => {
      const fresh = await seedWorkspace(db(), `policy-history-${String(Date.now())}`);
      const [theirProfile] = fresh.profiles as [SeededProfile];
      await db().automationPolicy.create({
        data: {
          workspaceId: theirProfile.context.workspaceId,
          businessProfileId: theirProfile.businessProfileId,
          mandatoryReviewReasons: [...MANDATORY_REVIEW_REASON_CODES],
        },
      });
      for (let index = 0; index < 5; index += 1) {
        const current = (await readPolicies(db(), theirProfile.context)).find((policy) => policy.channelAccountId === null);
        const outcome = await savePolicy(db(), theirProfile.context, null, {
          businessGoal: `change ${String(index)}`,
          expectedVersion: current?.version ?? 1,
        });
        expect(outcome.status, `change ${String(index)} was not saved`).toBe("SAVED");
      }

      const first = await listPolicyAudits(db(), theirProfile.context, { limit: 2 });
      expect(first.entries.map((entry) => (entry.after as { businessGoal: string }).businessGoal)).toEqual(["change 4", "change 3"]);
      expect(first.nextCursor).toBeDefined();

      const second = await listPolicyAudits(db(), theirProfile.context, { limit: 2, ...(first.nextCursor === undefined ? {} : { cursor: first.nextCursor }) });
      expect(second.entries.map((entry) => (entry.after as { businessGoal: string }).businessGoal)).toEqual(["change 2", "change 1"]);

      const third = await listPolicyAudits(db(), theirProfile.context, { limit: 2, ...(second.nextCursor === undefined ? {} : { cursor: second.nextCursor }) });
      expect(third.entries.map((entry) => (entry.after as { businessGoal: string }).businessGoal)).toEqual(["change 0"]);
      // The last page says it is the last one. A cursor here would make the caller ask for ever.
      expect(third.nextCursor).toBeUndefined();
    }, 180_000);

    it("separates two entries that share an instant", async () => {
      const fresh = await seedWorkspace(db(), `policy-tie-${String(Date.now())}`);
      const [theirProfile] = fresh.profiles as [SeededProfile];
      const sameInstant = new Date("2026-09-01T10:00:00.000Z");
      const rows = ["older", "newer"].map((goal) => ({
        workspaceId: theirProfile.context.workspaceId,
        businessProfileId: theirProfile.businessProfileId,
        actorUserId: fresh.ownerUserId,
        changedAt: sameInstant,
        impacts: [],
        before: {},
        after: { businessGoal: goal },
      }));
      await db().policyChangeAudit.createMany({ data: rows });

      // One at a time, over two rows with identical `changed_at`. A cursor on the instant alone either
      // repeats the first row for ever or skips the second entirely; both read as a change that did not
      // happen the way it happened.
      const seen: string[] = [];
      let cursor = (await listPolicyAudits(db(), theirProfile.context, { limit: 1 })).nextCursor;
      seen.push(...(await listPolicyAudits(db(), theirProfile.context, { limit: 1 })).entries.map((entry) => entry.id));
      while (cursor !== undefined) {
        const page = await listPolicyAudits(db(), theirProfile.context, { limit: 1, cursor });
        seen.push(...page.entries.map((entry) => entry.id));
        cursor = page.nextCursor;
      }

      expect(new Set(seen).size).toBe(2);
    }, 180_000);
  });

  describe("scope", () => {
    it("says GONE for a channel account that is not this profile's", async () => {
      // GONE rather than CONFLICT, and the version named here is deliberately not any stored one: a
      // policy that does not exist cannot have a version, so the existence answer has to come first.
      expect(await savePolicy(db(), profile.context, "ca_not_here", { mode: "DRAFT", expectedVersion: 99 })).toEqual({ status: "GONE" });
    }, 180_000);

    it("cannot edit another Workspace's policy by naming it", async () => {
      const [theirProfile] = neighbour.profiles as [SeededProfile];
      const theirs = await db().automationPolicy.findFirst({
        where: { workspaceId: theirProfile.context.workspaceId, businessProfileId: theirProfile.businessProfileId, channelAccountId: null },
        select: { mode: true },
      });

      // The scope comes from the authorized context, so there is no id a caller could pass to reach it.
      await save({ mode: "AUTOPILOT" });

      const after = await db().automationPolicy.findFirst({
        where: { workspaceId: theirProfile.context.workspaceId, businessProfileId: theirProfile.businessProfileId, channelAccountId: null },
        select: { mode: true },
      });
      expect(after?.mode).toBe(theirs?.mode);
    }, 180_000);
  });
});
