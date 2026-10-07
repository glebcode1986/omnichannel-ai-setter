/**
 * What a billing screen is told, against a real server (#42).
 *
 * The cases worth writing are the ones where a screen would mislead somebody about their own account: a
 * trial that has expired but still reads active, an allowance that reads healthy at its last second, a
 * limit shown without the count that makes it meaningful, and a provider identifier reaching a page.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { publishAcceptedCatalog, type PublishedCatalog } from "./accepted-catalog";
import { readBillingOverview } from "./billing-overview";
import { grantUsageTopUp, setWorkspaceAddOn } from "./catalog-store";
import { publishPlanVersion, requestCancellation, resumeSubscription, setWorkspaceSubscription } from "./entitlement-store";
import { commitReservation, reserveUsage } from "./usage-store";
import { createBusinessProfile } from "./repositories/workspaces";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { seedWorkspace } from "./testing/fixtures";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const DAY = 86_400_000;

describe.skipIf(!databaseTestsEnabled())("the billing overview", () => {
  let database: TestDatabase;
  let published: PublishedCatalog;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    published = await publishAcceptedCatalog(database.db);
  }, 300_000);

  afterAll(async () => {
    await database?.dispose();
  });

  const db = () => database.db;
  let sequence = 0;

  const onPlan = async (label: string, code: string, state: Parameters<typeof setWorkspaceSubscription>[2]["state"] = "ACTIVE", extra: Partial<Parameters<typeof setWorkspaceSubscription>[2]> = {}) => {
    sequence += 1;
    const seeded = await seedWorkspace(db(), `billing-${label}-${String(sequence)}`);
    const plan = published.plans.find((entry) => entry.code === code);
    await setWorkspaceSubscription(db(), seeded.context, { planVersionId: plan?.planVersionId ?? "", state, ...extra });
    return seeded;
  };

  describe("the plan a workspace is on", () => {
    it("names the plan, the version and the price book", async () => {
      const seeded = await onPlan("starter", "starter");

      const overview = await readBillingOverview(db(), seeded.workspaceId, NOW);

      expect(overview.subscription).toMatchObject({ state: "ACTIVE", planCode: "starter", planName: "Starter", planVersion: 1 });
      expect(overview.subscription?.prices).toEqual(
        expect.arrayContaining([
          { currency: "EUR", interval: "MONTH", amountCents: 4_900 },
          { currency: "EUR", interval: "YEAR", amountCents: 49_000 },
        ]) as unknown,
      );
    }, 300_000);

    it("carries no provider identifier anywhere in what it returns", async () => {
      const seeded = await onPlan("no-provider", "growth");
      await db().planPrice.updateMany({ where: {}, data: {} }).catch(() => undefined);

      const overview = await readBillingOverview(db(), seeded.workspaceId, NOW);

      // A value that reaches a page can reach a view-source. The screen needs an amount and a currency,
      // never the provider's own price object — so it is dropped by construction rather than by a rule
      // somebody has to remember while editing a component later.
      expect(JSON.stringify(overview)).not.toContain("providerPriceId");
      expect(JSON.stringify(overview)).not.toContain("provider_price_id");
    }, 300_000);

    it("says a workspace with no plan has none, rather than inventing a lapsed one", async () => {
      sequence += 1;
      const seeded = await seedWorkspace(db(), `billing-none-${String(sequence)}`);
      await db().workspaceSubscription.deleteMany({ where: { workspaceId: seeded.workspaceId } });

      const overview = await readBillingOverview(db(), seeded.workspaceId, NOW);

      // Pre-trial is not the same as lapsed, and a screen that showed "cancelled" to a workspace that had
      // never subscribed would be telling it something untrue.
      expect(overview.subscription).toBeUndefined();
      expect(overview.entitlement.subscribed).toBe(false);
    }, 300_000);

    it("reports a trial that has expired as unable to do paid work, while still naming the plan", async () => {
      const seeded = await onPlan("expired-trial", "growth", "TRIALING", { trialEndsAt: new Date(NOW.getTime() - DAY) });

      const overview = await readBillingOverview(db(), seeded.workspaceId, NOW);

      expect(overview.access.paidWorkAllowed).toBe(false);
      // The plan still says what it says: "your trial ended" and "your plan excludes this" are different
      // sentences and must not be made to read like each other.
      expect(overview.entitlement.features.AUTOPILOT).toBe(true);
      expect(overview.subscription?.state).toBe("TRIALING");
    }, 300_000);

    it("shows a requested cancellation with the date it bites, and lets it be withdrawn", async () => {
      const endsAt = new Date(NOW.getTime() + 10 * DAY);
      const seeded = await onPlan("canceling", "scale", "ACTIVE", { periodEndsAt: endsAt });

      expect(await requestCancellation(db(), seeded.context, NOW)).toEqual({ status: "CANCELING", endsAt });
      const canceling = await readBillingOverview(db(), seeded.workspaceId, NOW);
      expect(canceling.subscription).toMatchObject({ state: "CANCELED_PENDING_END", canceledAt: NOW, periodEndsAt: endsAt });
      // The period already paid for still works, which is the whole meaning of cancel-at-period-end.
      expect(canceling.access.paidWorkAllowed).toBe(true);

      expect(await resumeSubscription(db(), seeded.context, NOW)).toEqual({ status: "RESUMED" });
      const resumed = await readBillingOverview(db(), seeded.workspaceId, NOW);
      expect(resumed.subscription).toMatchObject({ state: "ACTIVE" });
      expect(resumed.subscription?.canceledAt).toBeUndefined();
    }, 300_000);
  });

  describe("capacity", () => {
    it("shows what is in use beside what is allowed", async () => {
      const seeded = await onPlan("capacity", "starter");

      const overview = await readBillingOverview(db(), seeded.workspaceId, NOW);
      const profiles = overview.capacity.find((entry) => entry.limit === "BUSINESS_PROFILES");

      // A ceiling alone says what is allowed; only a count says what exists, and the two differ exactly
      // when somebody needs to be told about it.
      expect(profiles).toEqual({ limit: "BUSINESS_PROFILES", inUse: 1, ceiling: 1 });
    }, 300_000);

    it("counts what a bought add-on added to the ceiling", async () => {
      const seeded = await onPlan("addon-capacity", "starter");
      const extra = published.addOns.find((entry) => entry.code === "extra-business-profile");
      await setWorkspaceAddOn(db(), seeded.context, { addOnVersionId: extra?.addOnVersionId ?? "", quantity: 2, activeFrom: NOW });
      await createBusinessProfile(db(), seeded.context, { name: "Second" }, NOW);

      const overview = await readBillingOverview(db(), seeded.workspaceId, NOW);

      expect(overview.capacity.find((entry) => entry.limit === "BUSINESS_PROFILES")).toEqual({
        limit: "BUSINESS_PROFILES",
        inUse: 2,
        ceiling: 3,
      });
      expect(overview.addOns).toEqual([{ code: "extra-business-profile", name: "One more Business Profile", kind: "RECURRING_CAPACITY", quantity: 2 }]);
    }, 300_000);

    it("leaves the ceiling absent where the plan caps nothing", async () => {
      sequence += 1;
      const seeded = await seedWorkspace(db(), `billing-uncapped-${String(sequence)}`);
      const uncapped = await publishPlanVersion(db(), {
        code: `billing-uncapped-plan-${String(sequence)}`,
        name: "Uncapped",
        availability: "PRIVATE",
        grants: { features: ["AI_DRAFTS"], limits: {}, quotas: {} },
      });
      await setWorkspaceSubscription(db(), seeded.context, { planVersionId: uncapped.planVersionId, state: "ACTIVE" });

      const overview = await readBillingOverview(db(), seeded.workspaceId, NOW);

      // Absent is a real answer rather than a missing one, and a screen that showed zero would read as
      // "you may have none of these".
      expect(overview.capacity.find((entry) => entry.limit === "SEATS")?.ceiling).toBeUndefined();
    }, 300_000);
  });

  describe("allowances", () => {
    it("shows included, used, remaining and when the cycle turns over", async () => {
      const seeded = await onPlan("allowance", "starter");

      const overview = await readBillingOverview(db(), seeded.workspaceId, NOW);
      const voice = overview.allowances.find((entry) => entry.metric === "VOICE_TRANSCRIPTION_SECONDS");

      // Starter sells 300 minutes, stored and reported as seconds because that is what the provider
      // measures.
      expect(voice).toMatchObject({ included: 300 * 60, used: 0, remaining: 300 * 60, health: "OK" });
      expect(voice?.resetsAt.getTime()).toBeGreaterThan(NOW.getTime());
    }, 300_000);

    it("counts a hold as spent, because it is not available to the person reading it", async () => {
      const seeded = await onPlan("holds", "starter");
      await reserveUsage(db(), {
        workspaceId: seeded.workspaceId,
        metric: "VOICE_TRANSCRIPTION_SECONDS",
        usageOperationId: `billing-hold-${String(sequence)}`,
        amount: 600,
        at: NOW,
      });

      const voice = (await readBillingOverview(db(), seeded.workspaceId, NOW)).allowances[0];

      // Reporting a hold as free would promise room that the recording currently being read will take.
      expect(voice).toMatchObject({ used: 600, remaining: 300 * 60 - 600 });
    }, 300_000);

    it("warns before exhaustion rather than with it", async () => {
      sequence += 1;
      const seeded = await seedWorkspace(db(), `billing-warn-${String(sequence)}`);
      const tiny = await publishPlanVersion(db(), {
        code: `billing-tiny-${String(sequence)}`,
        name: "Tiny",
        availability: "PRIVATE",
        grants: { features: ["VOICE_TRANSCRIPTION"], limits: {}, quotas: { VOICE_TRANSCRIPTION_SECONDS: 100 } },
      });
      await setWorkspaceSubscription(db(), seeded.context, { planVersionId: tiny.planVersionId, state: "ACTIVE" });
      const operation = `billing-warn-op-${String(sequence)}`;
      await reserveUsage(db(), { workspaceId: seeded.workspaceId, metric: "VOICE_TRANSCRIPTION_SECONDS", usageOperationId: operation, amount: 95, at: NOW });
      await commitReservation(db(), { workspaceId: seeded.workspaceId, metric: "VOICE_TRANSCRIPTION_SECONDS", usageOperationId: operation, amount: 95, at: NOW });

      expect((await readBillingOverview(db(), seeded.workspaceId, NOW)).allowances[0]).toMatchObject({ remaining: 5, health: "WARNING" });
    }, 300_000);

    it("shows a bought balance beside the included one, and when it lapses", async () => {
      const seeded = await onPlan("topup", "starter");
      const expiresAt = new Date(NOW.getTime() + 40 * DAY);
      await grantUsageTopUp(db(), seeded.context, { metric: "VOICE_TRANSCRIPTION_SECONDS", amount: 1_200, purchasedAt: NOW, expiresAt });

      const voice = (await readBillingOverview(db(), seeded.workspaceId, NOW)).allowances[0];

      expect(voice).toMatchObject({ included: 300 * 60, purchased: 1_200, remaining: 300 * 60 + 1_200 });
      expect(voice?.purchaseExpiresAt?.toISOString()).toBe(expiresAt.toISOString());
    }, 300_000);

    it("reports no allowance at all for a plan that does not sell the resource", async () => {
      sequence += 1;
      const seeded = await seedWorkspace(db(), `billing-no-voice-${String(sequence)}`);
      const plan = await publishPlanVersion(db(), {
        code: `billing-no-voice-plan-${String(sequence)}`,
        name: "No voice",
        availability: "PRIVATE",
        grants: { features: ["AI_DRAFTS"], limits: {}, quotas: {} },
      });
      await setWorkspaceSubscription(db(), seeded.context, { planVersionId: plan.planVersionId, state: "ACTIVE" });

      // Not a zero. "You have none of this" and "you have used it all" are different sentences with
      // different things to do about them.
      expect((await readBillingOverview(db(), seeded.workspaceId, NOW)).allowances).toEqual([]);
    }, 300_000);

    it("never reports an AI-reply allowance, because the plans do not sell one", async () => {
      const seeded = await onPlan("unmetered", "scale");

      const overview = await readBillingOverview(db(), seeded.workspaceId, NOW);

      // Core generation is customer-facing unmetered. The internal counter stays visible to operations
      // and must never appear to a customer as a bill.
      expect(overview.allowances.map((entry) => entry.metric)).toEqual(["VOICE_TRANSCRIPTION_SECONDS"]);
      expect(JSON.stringify(overview)).not.toContain("AI_GENERATION_CYCLES");
    }, 300_000);
  });

  describe("the catalogue beside it", () => {
    it("marks which offer is the one the workspace is on", async () => {
      const seeded = await onPlan("current", "growth");

      const overview = await readBillingOverview(db(), seeded.workspaceId, NOW);

      expect(overview.offers.filter((offer) => offer.current).map((offer) => offer.code)).toEqual(["growth"]);
      expect(overview.offers.map((offer) => offer.code)).toEqual(["starter", "growth", "scale"]);
    }, 300_000);

    it("marks none as current for a workspace on a withdrawn version", async () => {
      sequence += 1;
      const seeded = await seedWorkspace(db(), `billing-legacy-${String(sequence)}`);
      const legacy = await publishPlanVersion(db(), {
        code: `billing-legacy-plan-${String(sequence)}`,
        name: "Legacy",
        availability: "LEGACY",
        grants: { features: ["AI_DRAFTS"], limits: {}, quotas: {} },
      });
      await setWorkspaceSubscription(db(), seeded.context, { planVersionId: legacy.planVersionId, state: "ACTIVE" });

      const overview = await readBillingOverview(db(), seeded.workspaceId, NOW);

      // Grandfathered: the plan is still honoured and still named, and it is not on the pricing page.
      expect(overview.subscription?.planVersion).toBe(1);
      expect(overview.offers.some((offer) => offer.current)).toBe(false);
    }, 300_000);
  });

  it("keeps one workspace's billing out of another's", async () => {
    const mine = await onPlan("isolation-mine", "starter");
    const theirs = await onPlan("isolation-theirs", "scale");

    const overview = await readBillingOverview(db(), mine.workspaceId, NOW);

    expect(overview.subscription?.planCode).toBe("starter");
    expect(JSON.stringify(overview)).not.toContain(theirs.workspaceId);
  }, 300_000);

  it("says when it read, so a page can tell somebody how fresh the answer is", async () => {
    const seeded = await onPlan("read-at", "starter");

    // The browser is never the authority: whatever a checkout redirect claimed, this is the server's
    // answer and this is when it gave it.
    expect((await readBillingOverview(db(), seeded.workspaceId, NOW)).readAt.toISOString()).toBe(NOW.toISOString());
  }, 300_000);
});
