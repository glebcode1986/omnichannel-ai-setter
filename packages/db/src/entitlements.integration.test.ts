/**
 * Plans, subscriptions and what a workspace may actually do (#38, ADR-017).
 *
 * The claims worth proving are the ones a future pricing change would break if they were only
 * conventions: that a published plan version cannot move under the workspaces on it, that one
 * workspace's commercial state is invisible to another, and that nothing a payment provider says ever
 * reaches a feature check.
 */
import { featureAllowed, withinLimit, type PlanGrants } from "@omnichannel/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { publishPlanVersion, readEntitlement, setBillingAccount, setEntitlementOverride, setWorkspaceSubscription } from "./entitlement-store";
import { searchAuditEvents } from "./audit-store";
import { addTestMember, createTestUser, seedWorkspace } from "./testing/fixtures";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import type { authorizeWorkspaceAccess } from "./tenancy";

const NOW = new Date("2026-10-07T12:00:00.000Z");

/** Shaped like a real tier, but named for the test: the catalogue itself is #43's decision. */
const starter: PlanGrants = {
  features: ["AI_DRAFTS", "INSTAGRAM"],
  limits: { BUSINESS_PROFILES: 1, SEATS: 1 },
  quotas: { VOICE_TRANSCRIPTION_SECONDS: 18_000 },
};
const growth: PlanGrants = {
  features: ["AI_DRAFTS", "AUTOPILOT", "INSTAGRAM", "WHATSAPP", "MULTI_MEMBER"],
  limits: { BUSINESS_PROFILES: 3, SEATS: 5 },
  quotas: { VOICE_TRANSCRIPTION_SECONDS: 90_000 },
};

describe.skipIf(!databaseTestsEnabled())("plans, subscriptions and entitlements (PostgreSQL)", () => {
  let database: TestDatabase;
  let owner: Awaited<ReturnType<typeof authorizeWorkspaceAccess>>;
  let admin: Awaited<ReturnType<typeof authorizeWorkspaceAccess>>;
  let otherOwner: Awaited<ReturnType<typeof authorizeWorkspaceAccess>>;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let starterV1: string;
  let growthV1: string;
  const db = () => database.db;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    const seeded = await seedWorkspace(database.db, "billing");
    owner = seeded.context;
    workspaceId = seeded.workspaceId;
    const adminUserId = await createTestUser(database.db, "billing-admin");
    admin = await addTestMember(database.db, workspaceId, adminUserId, "ADMIN", "ALL");

    const second = await seedWorkspace(database.db, "billing-other");
    otherOwner = second.context;
    otherWorkspaceId = second.workspaceId;

    starterV1 = (await publishPlanVersion(database.db, { code: "starter-test", name: "Starter", grants: starter, monthlyPriceCents: 4_900, currency: "EUR" })).planVersionId;
    growthV1 = (await publishPlanVersion(database.db, { code: "growth-test", name: "Growth", grants: growth, monthlyPriceCents: 9_900, currency: "EUR" })).planVersionId;
  }, 120_000);

  afterAll(async () => {
    await database?.dispose();
  });

  describe("a published plan version", () => {
    it("cannot be edited, because workspaces are subscribed to it", async () => {
      // The rule lives in the database, not only in application code: a migration or a console session
      // would walk around a check that lived only in TypeScript, and the workspaces on this version
      // would silently find themselves on different terms.
      await expect(db().planVersion.update({ where: { id: starterV1 }, data: { limits: { BUSINESS_PROFILES: 99 } } })).rejects.toThrow(/immutable/u);
      await expect(db().planVersion.update({ where: { id: starterV1 }, data: { monthlyPriceCents: 1 } })).rejects.toThrow(/immutable/u);
      await expect(db().planVersion.update({ where: { id: starterV1 }, data: { features: ["AUTOPILOT"] } })).rejects.toThrow(/immutable/u);
    });

    it("cannot be deleted either, because that would erase what somebody bought", async () => {
      await expect(db().planVersion.delete({ where: { id: starterV1 } })).rejects.toThrow(/never deleted/u);
    });

    it("may still be withdrawn from sale, which is the one permitted change", async () => {
      await expect(db().planVersion.update({ where: { id: starterV1 }, data: { retiredAt: NOW } })).resolves.toBeDefined();
      await db().planVersion.update({ where: { id: starterV1 }, data: { retiredAt: null } });
    });

    it("gets the next number rather than replacing the one before it", async () => {
      const next = await publishPlanVersion(db(), { code: "starter-test", name: "Starter", grants: { ...starter, limits: { BUSINESS_PROFILES: 2, SEATS: 1 } } });

      expect(next.version).toBe(2);
      // And the first is still there, still saying what it always said.
      expect(await db().planVersion.findUniqueOrThrow({ where: { id: starterV1 }, select: { limits: true } })).toMatchObject({
        limits: { BUSINESS_PROFILES: 1, SEATS: 1 },
      });
    });

    it("refuses a price with no currency to spend it in", async () => {
      const plan = await db().planDefinition.findFirstOrThrow({ where: { code: "starter-test" }, select: { id: true } });

      await expect(db().planVersion.create({ data: { planId: plan.id, version: 99, monthlyPriceCents: 100 } })).rejects.toThrow(
        /plan_versions_shape_check/u,
      );
    });
  });

  describe("a workspace grandfathered on an old version", () => {
    it("keeps the terms it bought when a newer version is published", async () => {
      await setWorkspaceSubscription(db(), owner, { planVersionId: starterV1, state: "ACTIVE" });
      await publishPlanVersion(db(), { code: "starter-test", name: "Starter", grants: { ...starter, limits: { BUSINESS_PROFILES: 7, SEATS: 7 } } });

      const snapshot = await readEntitlement(db(), workspaceId, NOW);

      // The whole reason versions are immutable: publishing v3 must not move this workspace onto it.
      expect(snapshot.limits["BUSINESS_PROFILES"]).toBe(1);
      expect(snapshot.planVersion).toBe(1);
    });
  });

  describe("the normalized states", () => {
    const cases = [
      { state: "TRIALING", paid: true, trialEndsAt: NOW },
      { state: "ACTIVE", paid: true },
      { state: "PAST_DUE", paid: true },
      { state: "GRACE", paid: true, graceStartedAt: NOW },
      { state: "CANCELED_PENDING_END", paid: true, canceledAt: NOW, periodEndsAt: NOW },
      { state: "INACTIVE", paid: false },
    ] as const;

    for (const scenario of cases) {
      it(`maps ${scenario.state} to paid work ${scenario.paid ? "allowed" : "stopped"}`, async () => {
        await setWorkspaceSubscription(db(), owner, {
          planVersionId: growthV1,
          state: scenario.state,
          ...("trialEndsAt" in scenario ? { trialEndsAt: scenario.trialEndsAt } : {}),
          ...("graceStartedAt" in scenario ? { graceStartedAt: scenario.graceStartedAt } : {}),
          ...("canceledAt" in scenario ? { canceledAt: scenario.canceledAt } : {}),
          ...("periodEndsAt" in scenario ? { periodEndsAt: scenario.periodEndsAt } : {}),
        });

        const snapshot = await readEntitlement(db(), workspaceId, NOW);
        expect(snapshot.paidWorkAllowed).toBe(scenario.paid);
        expect(featureAllowed(snapshot, "AUTOPILOT")).toBe(scenario.paid);
      });
    }

    it("refuses a state whose clock does not support it", async () => {
      const subscription = await db().workspaceSubscription.findUniqueOrThrow({ where: { workspaceId }, select: { id: true } });

      // A trial with no end never ends; grace with no start cannot be measured against its three days.
      await expect(
        db().workspaceSubscription.update({ where: { id: subscription.id }, data: { state: "TRIALING", trialEndsAt: null } }),
      ).rejects.toThrow(/workspace_subscriptions_clock_check/u);
      await expect(
        db().workspaceSubscription.update({ where: { id: subscription.id }, data: { state: "GRACE", graceStartedAt: null } }),
      ).rejects.toThrow(/workspace_subscriptions_clock_check/u);
    });
  });

  describe("a workspace with no subscription at all", () => {
    it("is inactive on no plan, rather than an error nobody handled", async () => {
      const snapshot = await readEntitlement(db(), otherWorkspaceId, NOW);

      // The honest description of a workspace that has not started a trial, and also the safe one:
      // every feature check answers no.
      expect(snapshot).toMatchObject({ state: "INACTIVE", planCode: "none", planVersion: 0, paidWorkAllowed: false });
      expect(featureAllowed(snapshot, "AI_DRAFTS")).toBe(false);
      expect(withinLimit(snapshot, "SEATS", 0)).toBe(false);
    });
  });

  describe("an override", () => {
    it("raises a limit for one workspace and leaves every other one alone", async () => {
      await setWorkspaceSubscription(db(), owner, { planVersionId: growthV1, state: "ACTIVE" });
      await setWorkspaceSubscription(db(), otherOwner, { planVersionId: growthV1, state: "ACTIVE" });

      await setEntitlementOverride(db(), owner, { override: { limits: { BUSINESS_PROFILES: 50 } }, reason: "agency agreement" });

      expect((await readEntitlement(db(), workspaceId, NOW)).limits["BUSINESS_PROFILES"]).toBe(50);
      // The other workspace is on the same immutable version and must not have moved.
      expect((await readEntitlement(db(), otherWorkspaceId, NOW)).limits["BUSINESS_PROFILES"]).toBe(3);
    });

    it("stops applying once it expires, and the row stays so somebody can see what lapsed", async () => {
      await setEntitlementOverride(db(), owner, {
        override: { limits: { BUSINESS_PROFILES: 50 }, expiresAt: new Date(NOW.getTime() - 1) },
        reason: "incident apology",
      });

      expect((await readEntitlement(db(), workspaceId, NOW)).limits["BUSINESS_PROFILES"]).toBe(3);
      expect(await db().entitlementOverride.findUniqueOrThrow({ where: { workspaceId }, select: { reason: true } })).toMatchObject({
        reason: "incident apology",
      });
    });

    it("ignores a key the product has never heard of", async () => {
      await db().entitlementOverride.update({ where: { workspaceId }, data: { limits: { INVENTED_LIMIT: 5, BUSINESS_PROFILES: 9 }, expiresAt: null } });

      // A checked read, not a cast: a key a console session invented must not become an entitlement.
      const snapshot = await readEntitlement(db(), workspaceId, NOW);
      expect(snapshot.limits["BUSINESS_PROFILES"]).toBe(9);
      expect(Object.keys(snapshot.limits)).not.toContain("INVENTED_LIMIT");
      await setEntitlementOverride(db(), owner, undefined);
    });

    it("refuses one nobody explained", async () => {
      await expect(
        db().entitlementOverride.create({ data: { workspaceId, reason: "   ", grantedByUserId: owner.userId } }),
      ).rejects.toThrow(/entitlement_overrides_reason_check/u);
    });
  });

  describe("who may change commercial state", () => {
    it("is the owner, not an admin", async () => {
      // An admin runs the business's conversations; what the business pays for is the owner's.
      await expect(setWorkspaceSubscription(db(), admin, { planVersionId: growthV1, state: "ACTIVE" })).rejects.toThrow();
      await expect(setEntitlementOverride(db(), admin, { override: { limits: { SEATS: 99 } }, reason: "nope" })).rejects.toThrow();
      await expect(setBillingAccount(db(), admin, { provider: "example", providerCustomerId: "cus_1" })).rejects.toThrow();
    });
  });

  describe("the audit trail", () => {
    it("records what changed, in the product's own words", async () => {
      await setWorkspaceSubscription(db(), owner, { planVersionId: starterV1, state: "ACTIVE" });
      await setWorkspaceSubscription(db(), owner, { planVersionId: growthV1, state: "ACTIVE" });

      const audits = await searchAuditEvents(db(), owner, { kinds: ["SUBSCRIPTION_CHANGED"] });
      expect(audits.rows[0]).toMatchObject({ kind: "SUBSCRIPTION_CHANGED" });
      // "Moved to Growth" and "moved from Starter to Growth" are different sentences, and only the
      // second answers the question somebody is actually asking.
      expect(JSON.stringify(audits.rows[0]?.detail)).toContain("starter-test");
      expect(JSON.stringify(audits.rows[0]?.detail)).toContain("growth-test");
    });
  });

  describe("the provider boundary", () => {
    it("stores the provider's identifiers without letting them reach an entitlement", async () => {
      await setBillingAccount(db(), owner, { provider: "example-provider", providerCustomerId: "cus_opaque_1", providerSubscriptionId: "sub_opaque_1" });

      const snapshot = await readEntitlement(db(), workspaceId, NOW);

      // ADR-017's whole point: a provider's objects must not become product state. Nothing in a snapshot
      // names a provider, and replacing one is a change of rows rather than of plan semantics.
      expect(JSON.stringify(snapshot)).not.toContain("example-provider");
      expect(JSON.stringify(snapshot)).not.toContain("cus_opaque_1");
      expect(JSON.stringify(snapshot)).not.toContain("sub_opaque_1");
    });

    it("refuses provider identifiers that name no provider", async () => {
      await expect(
        db().billingAccount.update({ where: { workspaceId }, data: { provider: null, providerCustomerId: "cus_orphan" } }),
      ).rejects.toThrow(/billing_accounts_provider_check/u);
    });
  });

  describe("another workspace's commercial state", () => {
    it("is never reachable by naming it from this one", async () => {
      await setEntitlementOverride(db(), otherOwner, { override: { limits: { SEATS: 42 } }, reason: "theirs" });

      // Every mutation takes its workspace from the authorized context, never from an argument, so
      // there is no identifier a caller could supply to reach across.
      expect((await readEntitlement(db(), workspaceId, NOW)).limits["SEATS"]).toBe(5);
      expect((await readEntitlement(db(), otherWorkspaceId, NOW)).limits["SEATS"]).toBe(42);
    });
  });
});
