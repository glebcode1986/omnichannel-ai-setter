/**
 * The accepted commercial catalogue, against a real server (#43, PRICING_PACKAGING.md v0.6).
 *
 * The cases worth writing are the ones a plausible shortcut gets wrong: a version somebody edited instead
 * of republishing, an add-on that quietly upgraded the feature class of the plan it was bought alongside,
 * a top-up spent while the plan's own allowance was untouched, and a balance that lapsed while a
 * further-dated one was spent first.
 *
 * Two properties are asserted about the catalogue *as published* rather than about the publishing code:
 * the accepted numbers are the accepted numbers, and no tier exposes an AI-reply allowance.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ACCEPTED_ADDONS,
  ACCEPTED_CURRENCY,
  ACCEPTED_PLANS,
  ACCEPTED_TRIAL,
  publishAcceptedCatalog,
  type PublishedCatalog,
} from "./accepted-catalog";
import {
  consumeTopUp,
  endWorkspaceAddOn,
  grantUsageTopUp,
  publishAddOnVersion,
  readCatalog,
  readTopUpBalance,
  setWorkspaceAddOn,
} from "./catalog-store";
import { publishPlanVersion, readEntitlement, setWorkspaceSubscription } from "./entitlement-store";
import { commitReservation, readUsage, reserveUsage } from "./usage-store";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { seedWorkspace, type SeededWorkspace } from "./testing/fixtures";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const MINUTE = 60;

describe.skipIf(!databaseTestsEnabled())("the commercial catalogue", () => {
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
  const workspace = async (label: string): Promise<SeededWorkspace> => {
    sequence += 1;
    return seedWorkspace(db(), `catalog-${label}-${String(sequence)}`);
  };

  describe("what was published", () => {
    it("offers the three accepted tiers, in order, on the public pricing page", async () => {
      const catalog = await readCatalog(db());

      expect(catalog.plans.map((plan) => plan.code)).toEqual(["starter", "growth", "scale"]);
      expect(catalog.plans.every((plan) => plan.availability === "PUBLIC")).toBe(true);
    }, 300_000);

    it("carries the accepted monthly and annual prices, with annual stated rather than derived", async () => {
      const catalog = await readCatalog(db());

      for (const accepted of ACCEPTED_PLANS) {
        const plan = catalog.plans.find((entry) => entry.code === accepted.code);
        const monthly = plan?.prices.find((price) => price.interval === "MONTH");
        const annual = plan?.prices.find((price) => price.interval === "YEAR");
        expect(monthly).toMatchObject({ currency: ACCEPTED_CURRENCY, amountCents: accepted.monthlyCents });
        expect(annual).toMatchObject({ currency: ACCEPTED_CURRENCY, amountCents: accepted.annualCents });
        // The accepted rule, checked rather than assumed: pay ten months, receive twelve.
        expect(annual?.amountCents).toBe(accepted.monthlyCents * 10);
      }
    }, 300_000);

    it("carries the accepted capacities and voice allowances", async () => {
      const catalog = await readCatalog(db());

      for (const accepted of ACCEPTED_PLANS) {
        const plan = catalog.plans.find((entry) => entry.code === accepted.code);
        expect(plan?.limits["BUSINESS_PROFILES"]).toBe(accepted.businessProfiles);
        expect(plan?.limits["SEATS"]).toBe(accepted.seats);
        expect(plan?.limits["ANALYTICS_RETENTION_DAYS"]).toBe(accepted.analyticsRetentionDays);
        // Stated in the spec as minutes and stored as seconds, because the provider reports seconds.
        expect(plan?.quotas["VOICE_TRANSCRIPTION_SECONDS"]).toBe(accepted.voiceMinutes * MINUTE);
      }
    }, 300_000);

    it("exposes no AI-reply allowance on any tier", async () => {
      const catalog = await readCatalog(db());

      // The accepted commercial direction: core AI generation is customer-facing UNMETERED. The ledger
      // still counts generations internally, which must never appear as a billable allowance — and a
      // quota key is exactly how it would.
      for (const plan of catalog.plans) {
        expect(Object.keys(plan.quotas)).toEqual(["VOICE_TRANSCRIPTION_SECONDS"]);
      }
    }, 300_000);

    it("gives every paid tier the same features, so the tiers differ in capacity alone", async () => {
      const catalog = await readCatalog(db());
      const [first] = catalog.plans;

      for (const plan of catalog.plans) {
        expect([...plan.features].sort()).toEqual([...(first?.features ?? [])].sort());
      }
    }, 300_000);

    it("offers the five accepted add-ons at their accepted prices and intervals", async () => {
      const catalog = await readCatalog(db());

      expect(catalog.addOns.map((addOn) => addOn.code)).toEqual(ACCEPTED_ADDONS.map((addOn) => addOn.code));
      for (const accepted of ACCEPTED_ADDONS) {
        const addOn = catalog.addOns.find((entry) => entry.code === accepted.code);
        const price = addOn?.prices[0];
        // Capacity recurs; an allowance top-up is bought once. Priced the other way round, the catalogue
        // would describe a subscription nobody can cancel or a one-off charge that never stops.
        expect(price?.interval).toBe("monthlyCents" in accepted ? "MONTH" : "ONE_TIME");
        expect(price?.amountCents).toBe("monthlyCents" in accepted ? accepted.monthlyCents : accepted.onceCents);
      }
    }, 300_000);

    it("records no provider price identifiers, because none has been chosen yet", async () => {
      const catalog = await readCatalog(db());

      // They are references a billing adapter fills in (#41). The catalogue is interpretable without
      // them, which is the property that lets the provider change between terms.
      expect(catalog.plans.flatMap((plan) => plan.prices).every((price) => price.providerPriceId === undefined)).toBe(true);
    }, 300_000);

    it("states the accepted trial as configuration rather than as code", () => {
      expect(ACCEPTED_TRIAL).toMatchObject({ days: 14, cardRequired: false, businessProfiles: 1, seats: 3, voiceTranscriptionMinutes: 100 });
    });
  });

  describe("versions and grandfathering", () => {
    it("refuses to change what a published add-on version grants, or to delete it", async () => {
      const version = published.addOns[0];

      // A workspace buys a version, so editing one would change the terms of every workspace that bought
      // it. Enforced by a trigger, because a rule that lives only in application code is one a migration
      // or a console session can walk around.
      await expect(
        db().addOnVersion.update({ where: { id: version?.addOnVersionId }, data: { limits: { BUSINESS_PROFILES: 99 } } }),
      ).rejects.toThrow(/immutable/u);
      await expect(db().addOnVersion.update({ where: { id: version?.addOnVersionId }, data: { kind: "ONE_TIME_ALLOWANCE" } })).rejects.toThrow(
        /immutable/u,
      );
      await expect(db().addOnVersion.delete({ where: { id: version?.addOnVersionId } })).rejects.toThrow(/never deleted/u);
    }, 300_000);

    it("may still be withdrawn from sale, which is the one permitted change", async () => {
      const version = published.addOns[0];

      // The same exemption a plan version has, for the same reason: whether something is for sale is not
      // one of its terms, and withdrawing an add-on by publishing a new version would mean publishing one
      // nobody can buy.
      await expect(
        db().addOnVersion.update({ where: { id: version?.addOnVersionId }, data: { availability: "LEGACY" } }),
      ).resolves.toBeDefined();
      await db().addOnVersion.update({ where: { id: version?.addOnVersionId }, data: { availability: "PUBLIC" } });
    }, 300_000);

    it("refuses to edit a price a customer may already have been charged", async () => {
      const plan = published.plans[0];

      await expect(db().planPrice.updateMany({ where: { planVersionId: plan?.planVersionId }, data: { amountCents: 1 } })).rejects.toThrow(
        /immutable/u,
      );
    }, 300_000);

    it("leaves a workspace on the version it subscribed to when a newer one is published", async () => {
      const seeded = await workspace("grandfathered");
      const first = await publishPlanVersion(db(), {
        code: "grandfather-test",
        name: "Grandfather",
        availability: "PUBLIC",
        grants: { features: ["AI_DRAFTS"], limits: { SEATS: 2 }, quotas: {} },
        prices: [{ currency: "EUR", interval: "MONTH", amountCents: 1_000 }],
      });
      await setWorkspaceSubscription(db(), seeded.context, { planVersionId: first.planVersionId, state: "ACTIVE" });

      await publishPlanVersion(db(), {
        code: "grandfather-test",
        name: "Grandfather",
        availability: "PUBLIC",
        grants: { features: ["AI_DRAFTS"], limits: { SEATS: 99 }, quotas: {} },
        prices: [{ currency: "EUR", interval: "MONTH", amountCents: 2_000 }],
      });

      // The whole point of immutable versions: publishing v2 must not move this workspace onto it.
      expect((await readEntitlement(db(), seeded.workspaceId, NOW)).limits["SEATS"]).toBe(2);
    }, 300_000);

    it("keeps a withdrawn version interpretable while hiding it from the pricing page", async () => {
      const seeded = await workspace("legacy");
      const legacy = await publishPlanVersion(db(), {
        code: "legacy-test",
        name: "Legacy",
        availability: "LEGACY",
        grants: { features: ["AI_DRAFTS"], limits: { SEATS: 4 }, quotas: {} },
        prices: [{ currency: "EUR", interval: "MONTH", amountCents: 3_000 }],
      });
      await setWorkspaceSubscription(db(), seeded.context, { planVersionId: legacy.planVersionId, state: "ACTIVE" });

      expect((await readCatalog(db())).plans.map((plan) => plan.code)).not.toContain("legacy-test");
      expect((await readCatalog(db(), ["LEGACY"])).plans.map((plan) => plan.code)).toContain("legacy-test");
      // And the workspace on it is entitled to exactly what it bought.
      expect((await readEntitlement(db(), seeded.workspaceId, NOW)).limits["SEATS"]).toBe(4);
    }, 300_000);

    it("hides a private version from the public page without withdrawing it", async () => {
      await publishPlanVersion(db(), {
        code: "private-test",
        name: "Private",
        availability: "PRIVATE",
        grants: { features: ["AI_DRAFTS"], limits: {}, quotas: {} },
      });

      expect((await readCatalog(db())).plans.map((plan) => plan.code)).not.toContain("private-test");
      expect((await readCatalog(db(), ["PUBLIC", "PRIVATE"])).plans.map((plan) => plan.code)).toContain("private-test");
    }, 300_000);
  });

  describe("recurring capacity add-ons", () => {
    const starterFor = async (seeded: SeededWorkspace) => {
      const starter = published.plans.find((plan) => plan.code === "starter");
      await setWorkspaceSubscription(db(), seeded.context, { planVersionId: starter?.planVersionId ?? "", state: "ACTIVE" });
    };
    const addOn = (code: string) => published.addOns.find((entry) => entry.code === code)?.addOnVersionId ?? "";

    it("raises the ceiling it grants, by the quantity bought", async () => {
      const seeded = await workspace("extra-profiles");
      await starterFor(seeded);

      await setWorkspaceAddOn(db(), seeded.context, { addOnVersionId: addOn("extra-business-profile"), quantity: 3, activeFrom: NOW });

      // Starter includes one, and three more were bought.
      expect((await readEntitlement(db(), seeded.workspaceId, NOW)).limits["BUSINESS_PROFILES"]).toBe(4);
    }, 300_000);

    it("does not upgrade the feature class of the base plan", async () => {
      const seeded = await workspace("feature-class");
      // A plan deliberately missing a feature, so "the add-on did not add it" is a real assertion rather
      // than one every plan would pass.
      const sparse = await publishPlanVersion(db(), {
        code: "sparse-test",
        name: "Sparse",
        availability: "PRIVATE",
        grants: { features: ["AI_DRAFTS"], limits: { BUSINESS_PROFILES: 1 }, quotas: {} },
      });
      await setWorkspaceSubscription(db(), seeded.context, { planVersionId: sparse.planVersionId, state: "ACTIVE" });

      await setWorkspaceAddOn(db(), seeded.context, { addOnVersionId: addOn("extra-business-profile"), quantity: 1, activeFrom: NOW });
      const snapshot = await readEntitlement(db(), seeded.workspaceId, NOW);

      expect(snapshot.limits["BUSINESS_PROFILES"]).toBe(2);
      // Capacity, never capability: a business on Starter with extra profiles is still on Starter.
      expect(snapshot.features.AUTOPILOT).toBe(false);
      expect(snapshot.features.WHATSAPP).toBe(false);
    }, 300_000);

    it("leaves an uncapped ceiling uncapped", async () => {
      const seeded = await workspace("uncapped");
      const uncapped = await publishPlanVersion(db(), {
        code: "uncapped-test",
        name: "Uncapped",
        availability: "PRIVATE",
        grants: { features: ["AI_DRAFTS"], limits: {}, quotas: {} },
      });
      await setWorkspaceSubscription(db(), seeded.context, { planVersionId: uncapped.planVersionId, state: "ACTIVE" });

      await setWorkspaceAddOn(db(), seeded.context, { addOnVersionId: addOn("extra-seat"), quantity: 2, activeFrom: NOW });

      // The trap: turning "no ceiling" into "a ceiling of two" would take capacity away from a business
      // that just bought more of it.
      expect((await readEntitlement(db(), seeded.workspaceId, NOW)).limits["SEATS"]).toBeUndefined();
    }, 300_000);

    it("keeps granting until the end of the period already paid for", async () => {
      const seeded = await workspace("ends-later");
      await starterFor(seeded);
      await setWorkspaceAddOn(db(), seeded.context, { addOnVersionId: addOn("extra-business-profile"), quantity: 1, activeFrom: NOW });
      const endsAt = new Date(NOW.getTime() + 86_400_000);

      await endWorkspaceAddOn(db(), seeded.context, { addOnVersionId: addOn("extra-business-profile"), activeUntil: endsAt });

      // Dated rather than deleted: removal takes effect at the end of the paid period, and a row removed
      // now would take capacity from a business that has paid for it until tomorrow.
      expect((await readEntitlement(db(), seeded.workspaceId, NOW)).limits["BUSINESS_PROFILES"]).toBe(2);
      expect((await readEntitlement(db(), seeded.workspaceId, new Date(endsAt.getTime() + 1_000))).limits["BUSINESS_PROFILES"]).toBe(1);
    }, 300_000);

    it("grants nothing before it begins", async () => {
      const seeded = await workspace("starts-later");
      await starterFor(seeded);
      const later = new Date(NOW.getTime() + 86_400_000);

      await setWorkspaceAddOn(db(), seeded.context, { addOnVersionId: addOn("extra-business-profile"), quantity: 1, activeFrom: later });

      expect((await readEntitlement(db(), seeded.workspaceId, NOW)).limits["BUSINESS_PROFILES"]).toBe(1);
      expect((await readEntitlement(db(), seeded.workspaceId, later)).limits["BUSINESS_PROFILES"]).toBe(2);
    }, 300_000);

    it("refuses to hold a one-time top-up as a subscription", async () => {
      const seeded = await workspace("topup-as-subscription");
      await starterFor(seeded);

      // A top-up is a balance, not something a workspace *has*. Holding one as a recurring add-on would
      // grant its allowance for ever.
      await expect(setWorkspaceAddOn(db(), seeded.context, { addOnVersionId: addOn("voice-500"), quantity: 1, activeFrom: NOW })).rejects.toThrow(
        /balance/u,
      );
    }, 300_000);

    it("refuses an add-on priced against the wrong kind", async () => {
      await expect(
        publishAddOnVersion(db(), {
          code: "wrong-interval-test",
          name: "Wrong interval",
          kind: "ONE_TIME_ALLOWANCE",
          quotas: { VOICE_TRANSCRIPTION_SECONDS: 60 },
          prices: [{ currency: "EUR", interval: "MONTH", amountCents: 100 }],
        }),
      ).rejects.toThrow(/cannot be priced/u);
      await expect(
        publishAddOnVersion(db(), {
          code: "wrong-grant-test",
          name: "Wrong grant",
          kind: "RECURRING_CAPACITY",
          quotas: { VOICE_TRANSCRIPTION_SECONDS: 60 },
          prices: [{ currency: "EUR", interval: "MONTH", amountCents: 100 }],
        }),
      ).rejects.toThrow(/capacity and nothing else/u);
    }, 300_000);
  });

  describe("voice top-ups", () => {
    const tinyPlanFor = async (seeded: SeededWorkspace, includedSeconds: number) => {
      const plan = await publishPlanVersion(db(), {
        code: `topup-plan-${String(sequence)}`,
        name: "Top-up test plan",
        availability: "PRIVATE",
        grants: { features: ["VOICE_TRANSCRIPTION"], limits: {}, quotas: { VOICE_TRANSCRIPTION_SECONDS: includedSeconds } },
      });
      await setWorkspaceSubscription(db(), seeded.context, { planVersionId: plan.planVersionId, state: "ACTIVE" });
    };

    it("is spent only after the plan's own allowance", async () => {
      const seeded = await workspace("included-first");
      await tinyPlanFor(seeded, 100);
      await grantUsageTopUp(db(), seeded.context, {
        metric: "VOICE_TRANSCRIPTION_SECONDS",
        amount: 500,
        purchasedAt: NOW,
        expiresAt: new Date(NOW.getTime() + 30 * 86_400_000),
      });

      // Sixty of the hundred included: the balance must be untouched.
      const first = await reserveUsage(db(), {
        workspaceId: seeded.workspaceId,
        metric: "VOICE_TRANSCRIPTION_SECONDS",
        usageOperationId: "topup-op-1",
        amount: 60,
        at: NOW,
      });
      expect(first.status).toBe("RESERVED");
      await commitReservation(db(), {
        workspaceId: seeded.workspaceId,
        metric: "VOICE_TRANSCRIPTION_SECONDS",
        usageOperationId: "topup-op-1",
        amount: 60,
        at: NOW,
      });

      expect((await readTopUpBalance(db(), seeded.workspaceId, "VOICE_TRANSCRIPTION_SECONDS", NOW)).remaining).toBe(500);
    }, 300_000);

    it("covers what spills past the included allowance, and only that", async () => {
      const seeded = await workspace("straddles");
      await tinyPlanFor(seeded, 100);
      await grantUsageTopUp(db(), seeded.context, {
        metric: "VOICE_TRANSCRIPTION_SECONDS",
        amount: 500,
        purchasedAt: NOW,
        expiresAt: new Date(NOW.getTime() + 30 * 86_400_000),
      });

      // One hundred and twenty against an allowance of a hundred: twenty comes from the balance, not all
      // of it and not none.
      await reserveUsage(db(), {
        workspaceId: seeded.workspaceId,
        metric: "VOICE_TRANSCRIPTION_SECONDS",
        usageOperationId: "topup-op-2",
        amount: 120,
        at: NOW,
      });
      await commitReservation(db(), {
        workspaceId: seeded.workspaceId,
        metric: "VOICE_TRANSCRIPTION_SECONDS",
        usageOperationId: "topup-op-2",
        amount: 120,
        at: NOW,
      });

      expect((await readTopUpBalance(db(), seeded.workspaceId, "VOICE_TRANSCRIPTION_SECONDS", NOW)).remaining).toBe(480);
      expect((await readUsage(db(), seeded.workspaceId, NOW)).counters["VOICE_TRANSCRIPTION_SECONDS"]?.committed).toBe(120);
    }, 300_000);

    it("lets a reservation the plan alone could not cover succeed", async () => {
      const seeded = await workspace("rescued");
      await tinyPlanFor(seeded, 10);
      await grantUsageTopUp(db(), seeded.context, {
        metric: "VOICE_TRANSCRIPTION_SECONDS",
        amount: 300,
        purchasedAt: NOW,
        expiresAt: new Date(NOW.getTime() + 30 * 86_400_000),
      });

      const held = await reserveUsage(db(), {
        workspaceId: seeded.workspaceId,
        metric: "VOICE_TRANSCRIPTION_SECONDS",
        usageOperationId: "topup-op-3",
        amount: 200,
        at: NOW,
      });

      expect(held.status).toBe("RESERVED");
    }, 300_000);

    it("cannot rescue a plan that does not include the resource at all", async () => {
      const seeded = await workspace("not-included");
      const plan = await publishPlanVersion(db(), {
        code: `no-voice-plan-${String(sequence)}`,
        name: "No voice",
        availability: "PRIVATE",
        grants: { features: ["AI_DRAFTS"], limits: {}, quotas: {} },
      });
      await setWorkspaceSubscription(db(), seeded.context, { planVersionId: plan.planVersionId, state: "ACTIVE" });
      await grantUsageTopUp(db(), seeded.context, {
        metric: "VOICE_TRANSCRIPTION_SECONDS",
        amount: 300,
        purchasedAt: NOW,
        expiresAt: new Date(NOW.getTime() + 30 * 86_400_000),
      });

      // The allowance exists because a plan sells it. A balance bought against a plan that no longer
      // includes the resource is not a licence to use it — and the refusal says which of the two it is.
      expect(
        await reserveUsage(db(), {
          workspaceId: seeded.workspaceId,
          metric: "VOICE_TRANSCRIPTION_SECONDS",
          usageOperationId: "topup-op-4",
          amount: 10,
          at: NOW,
        }),
      ).toMatchObject({ status: "REFUSED", verdict: { kind: "NOT_INCLUDED" } });
    }, 300_000);

    it("spends the soonest to expire first, so nothing lapses that could have been used", async () => {
      const seeded = await workspace("expiry-order");
      await tinyPlanFor(seeded, 0);
      await grantUsageTopUp(db(), seeded.context, {
        metric: "VOICE_TRANSCRIPTION_SECONDS",
        amount: 100,
        purchasedAt: NOW,
        expiresAt: new Date(NOW.getTime() + 60 * 86_400_000),
      });
      await grantUsageTopUp(db(), seeded.context, {
        metric: "VOICE_TRANSCRIPTION_SECONDS",
        amount: 100,
        purchasedAt: NOW,
        expiresAt: new Date(NOW.getTime() + 10 * 86_400_000),
      });

      const outstanding = await consumeTopUp(db(), seeded.workspaceId, "VOICE_TRANSCRIPTION_SECONDS", 100, NOW);

      expect(outstanding).toBe(0);
      const soonest = await db().usageTopUp.findFirstOrThrow({
        where: { workspaceId: seeded.workspaceId },
        orderBy: { expiresAt: "asc" },
        select: { consumed: true },
      });
      // The nearer balance was spent whole; the further one is untouched.
      expect(soonest.consumed).toBe(100);
    }, 300_000);

    it("stops counting a balance once it has lapsed, and says when the next one will", async () => {
      const seeded = await workspace("lapsed");
      await tinyPlanFor(seeded, 0);
      await grantUsageTopUp(db(), seeded.context, {
        metric: "VOICE_TRANSCRIPTION_SECONDS",
        amount: 100,
        purchasedAt: new Date(NOW.getTime() - 90 * 86_400_000),
        expiresAt: new Date(NOW.getTime() - 1_000),
      });
      const liveUntil = new Date(NOW.getTime() + 5 * 86_400_000);
      await grantUsageTopUp(db(), seeded.context, {
        metric: "VOICE_TRANSCRIPTION_SECONDS",
        amount: 40,
        purchasedAt: NOW,
        expiresAt: liveUntil,
      });

      const balance = await readTopUpBalance(db(), seeded.workspaceId, "VOICE_TRANSCRIPTION_SECONDS", NOW);

      // The lapsed purchase is excluded rather than deleted: a business asking why its minutes ran out is
      // owed the answer that it bought some and they expired.
      expect(balance.remaining).toBe(40);
      expect(balance.nextExpiryAt?.toISOString()).toBe(liveUntil.toISOString());
      expect(await db().usageTopUp.count({ where: { workspaceId: seeded.workspaceId } })).toBe(2);
    }, 300_000);

    it("refuses to overspend a balance, however much is asked of it", async () => {
      const seeded = await workspace("overspend");
      await tinyPlanFor(seeded, 0);
      await grantUsageTopUp(db(), seeded.context, {
        metric: "VOICE_TRANSCRIPTION_SECONDS",
        amount: 50,
        purchasedAt: NOW,
        expiresAt: new Date(NOW.getTime() + 30 * 86_400_000),
      });

      const outstanding = await consumeTopUp(db(), seeded.workspaceId, "VOICE_TRANSCRIPTION_SECONDS", 80, NOW);

      // What it could not cover is returned rather than silently absorbed, and the CHECK would refuse a
      // row that claimed to have spent more than it held.
      expect(outstanding).toBe(30);
      expect((await readTopUpBalance(db(), seeded.workspaceId, "VOICE_TRANSCRIPTION_SECONDS", NOW)).remaining).toBe(0);
    }, 300_000);
  });
});
