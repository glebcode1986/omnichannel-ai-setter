/**
 * Automation settings, against a real server (Issue #30).
 *
 * The cases that matter are the ones where a careless implementation is silently wrong: a preset that
 * quietly dropped a mandatory-review topic, a save that changed nothing but left an audit row saying
 * somebody did something, and an audit that did not get written because it was a second statement.
 */
import { MANDATORY_REVIEW_REASON_CODES } from "@omnichannel/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listPolicyAudits, readPolicies, savePolicy } from "./policy-store";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { seedWorkspace, type SeededProfile, type SeededWorkspace } from "./testing/fixtures";

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

  beforeAll(ensureDefault, 60_000);

  describe("presets", () => {
    it("writes the values a preset name means, never values a caller sent", async () => {
      const outcome = await savePolicy(db(), profile.context, null, { confidencePreset: "CONSERVATIVE" });

      expect(outcome.status).toBe("SAVED");
      const policy = await theDefault();
      // 0.9 comes from the domain. A caller cannot ask for a threshold by naming a preset.
      expect(policy?.confidenceThreshold).toBe(0.9);
      expect(policy?.confidencePreset).toBe("CONSERVATIVE");
      expect(policy?.mandatoryReviewReasons).toContain("LOW_CONFIDENCE");
    }, 180_000);

    it("keeps every mandatory-review topic however permissive the preset", async () => {
      await savePolicy(db(), profile.context, null, { confidencePreset: "AGGRESSIVE" });

      const policy = await theDefault();
      for (const reason of MANDATORY_REVIEW_REASON_CODES) {
        expect(policy?.mandatoryReviewReasons, `AGGRESSIVE dropped ${reason}`).toContain(reason);
      }
    }, 180_000);

    it("cannot be told to drop a mandatory-review topic by hand either", async () => {
      // The domain re-adds the floor whatever the caller asked for, so this store cannot write a policy
      // that lets a payment dispute answer itself — and neither can anything built on it.
      await savePolicy(db(), profile.context, null, { confidence: { confidenceThreshold: 0.7, mandatoryReviewReasons: ["LOW_CONFIDENCE"] } });

      const policy = await theDefault();
      expect(policy?.mandatoryReviewReasons).toContain("PAYMENT_DISPUTE");
      expect(policy?.confidenceThreshold).toBe(0.7);
    }, 180_000);

    it("writes timing as the preset's ranges", async () => {
      await savePolicy(db(), profile.context, null, { timingPreset: "FAST" });

      const policy = await theDefault();
      expect(policy?.timingPreset).toBe("FAST");
      expect(policy?.deliveryDelayMs.maxMs).toBeLessThan(120_000);
    }, 180_000);

    it("reports a hand-tuned policy as custom rather than naming a preset", async () => {
      await savePolicy(db(), profile.context, null, {
        timing: { debounceWindowMs: { minMs: 1_000, maxMs: 2_000 }, deliveryDelayMs: { minMs: 4_000, maxMs: 9_000 } },
      });

      expect((await theDefault())?.timingPreset).toBe("CUSTOM");
    }, 180_000);

    it("refuses a request that names a preset and exact values at once", async () => {
      // Two answers to one question; whichever won would be an accident of ordering.
      expect(
        await savePolicy(db(), profile.context, null, {
          confidencePreset: "BALANCED",
          confidence: { confidenceThreshold: 0.5, mandatoryReviewReasons: [] },
        }),
      ).toEqual({ status: "REFUSED", reason: "choose a preset or exact values, not both" });
    }, 180_000);
  });

    it("refuses a request that names a timing preset and exact ranges at once", async () => {
      expect(
        await savePolicy(db(), profile.context, null, {
          timingPreset: "FAST",
          timing: { debounceWindowMs: { minMs: 1_000, maxMs: 2_000 }, deliveryDelayMs: { minMs: 3_000, maxMs: 4_000 } },
        }),
      ).toEqual({ status: "REFUSED", reason: "choose a timing preset or exact values, not both" });
    }, 180_000);

    it("accepts CUSTOM alongside exact ranges, because that is what CUSTOM means", async () => {
      // The guard is about a *named* preset contradicting values. `CUSTOM` names no values, so it agrees
      // with them rather than competing.
      const outcome = await savePolicy(db(), profile.context, null, {
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
      await savePolicy(db(), profile.context, null, { confidencePreset: "BALANCED", mode: "DRAFT" });
      const before = (await theDefault())?.confidenceThreshold;

      await savePolicy(db(), profile.context, null, { confidencePreset: "AGGRESSIVE" });

      const [latest] = await listPolicyAudits(db(), profile.context);
      expect(latest?.actorName).toBe("Test policy-owner");
      expect((latest?.before as { confidenceThreshold: number }).confidenceThreshold).toBe(before);
      expect((latest?.after as { confidenceThreshold: number }).confidenceThreshold).toBe(0.65);
      expect(latest?.impacts).toContain("CONFIDENCE_LOWERED");
    }, 180_000);

    it("names turning on autopilot as an impact", async () => {
      await savePolicy(db(), profile.context, null, { mode: "DRAFT" });

      await savePolicy(db(), profile.context, null, { mode: "AUTOPILOT" });

      expect((await listPolicyAudits(db(), profile.context))[0]?.impacts).toContain("AUTOPILOT_ENABLED");
    }, 180_000);

    it("writes no audit row for a save that changed nothing", async () => {
      await savePolicy(db(), profile.context, null, { confidencePreset: "BALANCED" });
      const countBefore = (await listPolicyAudits(db(), profile.context)).length;

      const outcome = await savePolicy(db(), profile.context, null, { confidencePreset: "BALANCED" });

      // A history where every click is an entry is a history nobody reads.
      expect(outcome).toEqual({ status: "UNCHANGED" });
      expect((await listPolicyAudits(db(), profile.context)).length).toBe(countBefore);
    }, 180_000);

    it("records a change with no visible effect, with no impacts", async () => {
      await savePolicy(db(), profile.context, null, { businessGoal: "Book appointments" });

      const [latest] = await listPolicyAudits(db(), profile.context);
      // "Did anyone touch this?" has a useful answer, and `impacts` says it widened nothing.
      expect(latest?.impacts).toEqual([]);
      expect((latest?.after as { businessGoal: string }).businessGoal).toBe("Book appointments");
    }, 180_000);

    it("reads newest first", async () => {
      await savePolicy(db(), profile.context, null, { businessGoal: "First goal" });
      await savePolicy(db(), profile.context, null, { businessGoal: "Second goal" });

      const audits = await listPolicyAudits(db(), profile.context);
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
      await savePolicy(db(), theirProfile.context, null, { businessGoal: "Their goal" });

      const mine = await listPolicyAudits(db(), profile.context);
      expect(mine.map((audit) => (audit.after as { businessGoal: string | null }).businessGoal)).not.toContain("Their goal");
    }, 180_000);
  });

  describe("the settings themselves", () => {
    it("stores the goal and the qualification criteria", async () => {
      await savePolicy(db(), profile.context, null, {
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
      await savePolicy(db(), profile.context, null, { businessGoal: "Something" });

      await savePolicy(db(), profile.context, null, { businessGoal: "   " });

      expect((await theDefault())?.businessGoal).toBeNull();
    }, 180_000);

    it("stores the Instagram and WhatsApp after-window choices", async () => {
      await savePolicy(db(), profile.context, null, {
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
      await savePolicy(db(), profile.context, null, { whatsappAfterWindowPolicy: "SERVICE_WINDOW_ONLY", whatsappTemplateAutomationAllowlist: [] });

      await savePolicy(db(), profile.context, null, { whatsappAfterWindowPolicy: "TEMPLATE_AUTOPILOT" });

      // ADR-016: enabled with nothing on the allowlist sends nothing, so it is a setting that looks on
      // and does nothing.
      const [latest] = await listPolicyAudits(db(), profile.context);
      expect(latest?.impacts).toContain("TEMPLATE_AUTOPILOT_WITHOUT_ALLOWLIST");
    }, 180_000);

    it("refuses a blank allowlist entry, in the domain's own words", async () => {
      const outcome = await savePolicy(db(), profile.context, null, { whatsappTemplateAutomationAllowlist: ["ok", "  "] });

      // The domain's own message, which names the field. Asserted on the string rather than through a
      // matcher, so the reason an operator would see is what the test reads.
      expect(outcome.status).toBe("REFUSED");
      expect(outcome.status === "REFUSED" ? outcome.reason : "").toContain("non-empty");
    }, 180_000);

    it("refuses a mode nobody defined", async () => {
      expect((await savePolicy(db(), profile.context, null, { mode: "SEMI_AUTO" as never })).status).toBe("REFUSED");
    }, 180_000);
  });

  describe("scope", () => {
    it("says GONE for a channel account that is not this profile's", async () => {
      expect(await savePolicy(db(), profile.context, "ca_not_here", { mode: "DRAFT" })).toEqual({ status: "GONE" });
    }, 180_000);

    it("cannot edit another Workspace's policy by naming it", async () => {
      const [theirProfile] = neighbour.profiles as [SeededProfile];
      const theirs = await db().automationPolicy.findFirst({
        where: { workspaceId: theirProfile.context.workspaceId, businessProfileId: theirProfile.businessProfileId, channelAccountId: null },
        select: { mode: true },
      });

      // The scope comes from the authorized context, so there is no id a caller could pass to reach it.
      await savePolicy(db(), profile.context, null, { mode: "AUTOPILOT" });

      const after = await db().automationPolicy.findFirst({
        where: { workspaceId: theirProfile.context.workspaceId, businessProfileId: theirProfile.businessProfileId, channelAccountId: null },
        select: { mode: true },
      });
      expect(after?.mode).toBe(theirs?.mode);
    }, 180_000);
  });
});
