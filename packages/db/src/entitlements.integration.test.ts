/**
 * Plans, subscriptions and what a workspace may actually do (#38, ADR-017).
 *
 * The claims worth proving are the ones a future pricing change would break if they were only
 * conventions: that a published plan version cannot move under the workspaces on it, that one
 * workspace's commercial state is invisible to another, and that nothing a payment provider says ever
 * reaches a feature check.
 */
import { featureAllowed, NO_CAPABILITIES, withinLimit, type PlanGrants } from "@omnichannel/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  publishPlanVersion,
  readEntitlement,
  requestCancellation,
  resumeSubscription,
  setBillingAccount,
  setEntitlementOverride,
  setWorkspaceSubscription,
} from "./entitlement-store";
import { grantUsageTopUp, setWorkspaceAddOn } from "./catalog-store";
import { searchAuditEvents } from "./audit-store";
import { addTestMember, createTestUser, seedWorkspace } from "./testing/fixtures";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { addWorkspaceMember, createBusinessProfile, createWorkspaceWithOwner } from "./repositories/workspaces";
import { connectChannelAccount } from "./repositories/channel-accounts";
import { authorizeBusinessProfileAccess, authorizeWorkspaceAccess } from "./tenancy";

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

    starterV1 = (await publishPlanVersion(database.db, { code: "starter-test", name: "Starter", grants: starter, prices: [{ currency: "EUR", interval: "MONTH", amountCents: 4_900 }] })).planVersionId;
    growthV1 = (await publishPlanVersion(database.db, { code: "growth-test", name: "Growth", grants: growth, prices: [{ currency: "EUR", interval: "MONTH", amountCents: 9_900 }] })).planVersionId;
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
      // The price book is immutable too, and by its own trigger: a price a customer was charged must stay
      // readable exactly as it was charged.
      await expect(db().planPrice.updateMany({ where: { planVersionId: starterV1 }, data: { amountCents: 1 } })).rejects.toThrow(/immutable/u);
      await expect(db().planVersion.update({ where: { id: starterV1 }, data: { features: ["AUTOPILOT"] } })).rejects.toThrow(/immutable/u);
    });

    it("cannot be deleted either, because that would erase what somebody bought", async () => {
      await expect(db().planVersion.delete({ where: { id: starterV1 } })).rejects.toThrow(/never deleted/u);
    });

    it("may still be withdrawn from sale, which is the one permitted change", async () => {
      await expect(db().planVersion.update({ where: { id: starterV1 }, data: { retiredAt: NOW } })).resolves.toBeDefined();
      await db().planVersion.update({ where: { id: starterV1 }, data: { retiredAt: null } });
      // `availability` says the same thing in more detail (#43) and is exempt for the same reason: a
      // catalogue that could only withdraw a plan by publishing a new version would have to publish one
      // nobody can buy.
      await expect(db().planVersion.update({ where: { id: starterV1 }, data: { availability: "LEGACY" } })).resolves.toBeDefined();
      await db().planVersion.update({ where: { id: starterV1 }, data: { availability: "PUBLIC" } });
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
      // The money invariants moved to `plan_prices` with the money itself (#43). A currency column that
      // accepted anything would quietly create a second price book for the same currency, so the shape is
      // a CHECK rather than a convention.
      await expect(
        db().planPrice.create({ data: { planVersionId: starterV1, currency: "eur", interval: "MONTH", amountCents: 100 } }),
      ).rejects.toThrow(/plan_prices_currency_check/u);
      await expect(
        db().planPrice.create({ data: { planVersionId: starterV1, currency: "EUR", interval: "YEAR", amountCents: -1 } }),
      ).rejects.toThrow(/plan_prices_amount_check/u);
      // And a subscription cannot be priced as a one-off, which would be a plan nobody could be
      // subscribed to.
      await expect(
        db().planPrice.create({ data: { planVersionId: starterV1, currency: "USD", interval: "ONE_TIME", amountCents: 100 } }),
      ).rejects.toThrow(/plan_prices_interval_check/u);
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
    // The deadlines are in the future for the states that still permit work, and in the past for the two
    // cases that exist to prove a deadline bites (#40). They used to be `NOW`, which meant the states
    // "permitted" work at the very instant their own period ended — the gap `paidWorkPermitted` closes.
    const LATER = new Date(NOW.getTime() + 86_400_000);
    const EARLIER = new Date(NOW.getTime() - 1_000);
    const cases = [
      { state: "TRIALING", paid: true, trialEndsAt: LATER },
      { state: "ACTIVE", paid: true },
      { state: "PAST_DUE", paid: true },
      { state: "GRACE", paid: true, graceStartedAt: NOW },
      { state: "CANCELED_PENDING_END", paid: true, canceledAt: NOW, periodEndsAt: LATER },
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

    /**
     * The two states that carry their own end date, past it (#40).
     *
     * Nothing writes a row when a date passes, so a check that read only the state kept a cancelled
     * workspace sending until a provider webhook happened to move it — and a trial working after it had
     * expired. This is also what the delivery claim's re-resolution exists for: a reply waiting out its
     * delay can cross either boundary with no row changing at all.
     */
    for (const scenario of [
      { state: "TRIALING" as const, fields: { trialEndsAt: EARLIER } },
      { state: "CANCELED_PENDING_END" as const, fields: { canceledAt: NOW, periodEndsAt: EARLIER } },
    ]) {
      it(`stops paid work for ${scenario.state} once its own deadline has passed`, async () => {
        await setWorkspaceSubscription(db(), owner, { planVersionId: growthV1, state: scenario.state, ...scenario.fields });

        const snapshot = await readEntitlement(db(), workspaceId, NOW);
        expect(snapshot.paidWorkAllowed).toBe(false);
        expect(featureAllowed(snapshot, "AUTOPILOT")).toBe(false);
        // And the plan still says what it says: "your trial ended" and "your plan excludes this" are
        // different sentences, and neither may be made to read like the other.
        expect(snapshot.features.AUTOPILOT).toBe(true);
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
      // Built here rather than taken from the fixture. Seeded workspaces are subscribed and paid up, so
      // that every other suite in this package tests its own subject instead of the billing gate (#40) —
      // which means the one test about having no subscription has to make that state itself.
      const unsubscribedOwner = await createTestUser(db(), "entitlements-unsubscribed-owner");
      const { workspaceId: unsubscribed } = await createWorkspaceWithOwner(db(), {
        name: "Workspace entitlements-unsubscribed",
        ownerUserId: unsubscribedOwner,
      });
      const snapshot = await readEntitlement(db(), unsubscribed, NOW);

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
      // Cancelling and resuming are the two a customer performs themselves (#42), so the restriction has
      // to hold on them too — a screen that offered an admin a cancel button would be offering a refusal.
      await expect(requestCancellation(db(), admin, NOW)).rejects.toThrow();
      await expect(resumeSubscription(db(), admin, NOW)).rejects.toThrow();
      await expect(setWorkspaceAddOn(db(), admin, { addOnVersionId: "whatever", quantity: 1 })).rejects.toThrow();
      await expect(grantUsageTopUp(db(), admin, { metric: "VOICE_TRANSCRIPTION_SECONDS", amount: 1, expiresAt: NOW })).rejects.toThrow();
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

  /**
   * The gates a plan actually closes (#40).
   *
   * Capacity and configuration, kept apart from payment on purpose: the spec stops paid AI generation,
   * automation and transcription, and insists the workspace itself stays usable while a payment is sorted
   * out. The case that decides the shape of all of it is the pre-trial one — connecting the first channel
   * is what *starts* a trial, so a gate that refused a workspace with no plan would shut the product's
   * own front door.
   */
  describe("cancelling", () => {
    it("refuses a subscription with no period end to cancel at", async () => {
      // A cancellation has to be dated to something. Without a period or a trial end there is nothing to
      // date it to, and one with no end is indistinguishable from an immediate one — which is not the
      // accepted default.
      await setWorkspaceSubscription(db(), owner, { planVersionId: growthV1, state: "ACTIVE" });

      expect(await requestCancellation(db(), owner, NOW)).toMatchObject({ status: "REFUSED" });
    });

    it("refuses to cancel twice, and to resume what is not ending", async () => {
      const endsAt = new Date(NOW.getTime() + 86_400_000);
      await setWorkspaceSubscription(db(), owner, { planVersionId: growthV1, state: "ACTIVE", periodEndsAt: endsAt });

      expect(await requestCancellation(db(), owner, NOW)).toEqual({ status: "CANCELING", endsAt });
      expect(await requestCancellation(db(), owner, NOW)).toMatchObject({ status: "REFUSED" });
      expect(await resumeSubscription(db(), owner, NOW)).toEqual({ status: "RESUMED" });
      expect(await resumeSubscription(db(), owner, NOW)).toMatchObject({ status: "REFUSED" });
    });

    it("refuses to resume a term that has already ended", async () => {
      const ended = new Date(NOW.getTime() - 1_000);
      await setWorkspaceSubscription(db(), owner, {
        planVersionId: growthV1,
        state: "CANCELED_PENDING_END",
        canceledAt: new Date(NOW.getTime() - 2_000),
        periodEndsAt: ended,
      });

      // What would be resumed has expired, and restoring it would grant a term nobody paid for.
      expect(await resumeSubscription(db(), owner, NOW)).toMatchObject({ status: "REFUSED" });
    });

    it("does not move the plan, so a cancellation cannot be a disguised downgrade", async () => {
      const endsAt = new Date(NOW.getTime() + 86_400_000);
      await setWorkspaceSubscription(db(), owner, { planVersionId: growthV1, state: "ACTIVE", periodEndsAt: endsAt });

      await requestCancellation(db(), owner, NOW);

      const after = await db().workspaceSubscription.findUniqueOrThrow({ where: { workspaceId }, select: { planVersionId: true } });
      expect(after.planVersionId).toBe(growthV1);
      // And the period already paid for still permits paid work, which is what cancel-at-period-end means.
      expect((await readEntitlement(db(), workspaceId, NOW)).paidWorkAllowed).toBe(true);
    });
  });

  describe("what a plan refuses", () => {
    const planWith = async (code: string, grants: PlanGrants) =>
      (await publishPlanVersion(db(), { code, name: code, grants })).planVersionId;

    const freshWorkspace = async (label: string) => {
      const ownerUserId = await createTestUser(db(), `capacity-${label}`);
      const { workspaceId } = await createWorkspaceWithOwner(db(), { name: `Workspace ${label}`, ownerUserId });
      return { ownerUserId, workspaceId, context: await authorizeWorkspaceAccess(db(), { userId: ownerUserId, workspaceId }) };
    };

    it("lets a workspace with no plan create its first Business Profile", async () => {
      // The act that starts the trial. Refusing it would make the product unreachable from its own front
      // door, and `withinLimit` — which folds payment in — refuses exactly this.
      const fresh = await freshWorkspace("pretrial");

      await expect(createBusinessProfile(db(), fresh.context, { name: "First" }, NOW)).resolves.toMatchObject({ name: "First" });
    }, 180_000);

    it("refuses one more Business Profile than the plan allows, and says which ceiling", async () => {
      const fresh = await freshWorkspace("one-profile");
      const planVersionId = await planWith("capacity-one-profile", { features: [], limits: { BUSINESS_PROFILES: 1 }, quotas: {} });
      await setWorkspaceSubscription(db(), fresh.context, { planVersionId, state: "ACTIVE" });
      await createBusinessProfile(db(), fresh.context, { name: "Only" }, NOW);

      await expect(createBusinessProfile(db(), fresh.context, { name: "Second" }, NOW)).rejects.toThrow(/BUSINESS_PROFILES/u);
      // And nothing was written: a refusal that left half a profile behind would be worse than none.
      expect(await db().businessProfile.count({ where: { workspaceId: fresh.workspaceId } })).toBe(1);
    }, 180_000);

    it("holds a capacity lock only for as long as the transaction that took it", async () => {
      // Pinned because the reason `createBusinessProfile` opens its own transaction is invisible at the
      // call site, and the refusal above passes with or without it.
      //
      // Both capacity checks are a count followed by an insert, which no index can cap, so each holds one
      // advisory lock across the pair. `createBusinessProfile` used to take a `DbExecutor` — a type that
      // deliberately omits `$transaction` — and call `pg_advisory_xact_lock` on it, so under autocommit
      // the lock was released by the end of the very statement that took it and the count and insert it
      // was meant to serialize ran unprotected. `addWorkspaceMember` always opened its own transaction,
      // which is why seats never had the problem and why profiles now match.
      const key = "capacity-lock-lifetime";
      const heldNow = async (): Promise<number> => {
        const rows = await db().$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n
          FROM pg_locks
          WHERE locktype = 'advisory'
            AND granted
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
        return rows[0]?.n ?? 0;
      };

      // Autocommit: the lock statement is its own transaction, so it is over before the next statement.
      await db().$queryRaw`SELECT true AS locked FROM pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      expect(await heldNow()).toBe(0);

      // Inside one, it survives every statement in the body and is released on commit.
      let duringTransaction = -1;
      await db().$transaction(async (tx) => {
        await tx.$queryRaw`SELECT true AS locked FROM pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        duringTransaction = await heldNow();
      });

      expect(duringTransaction).toBe(1);
      expect(await heldNow()).toBe(0);
    }, 180_000);

    it("lets a workspace whose payment lapsed keep reorganizing what it already owns", async () => {
      // Capacity is not payment. The spec keeps the workspace usable; what stops is sending.
      const fresh = await freshWorkspace("lapsed-profile");
      const planVersionId = await planWith("capacity-lapsed", { features: [], limits: { BUSINESS_PROFILES: 5 }, quotas: {} });
      await setWorkspaceSubscription(db(), fresh.context, { planVersionId, state: "INACTIVE" });

      await expect(createBusinessProfile(db(), fresh.context, { name: "Still allowed" }, NOW)).resolves.toMatchObject({ name: "Still allowed" });
    }, 180_000);

    it("refuses a second member on a plan that does not sell a team", async () => {
      const fresh = await freshWorkspace("solo-plan");
      const planVersionId = await planWith("capacity-solo", { features: ["AI_DRAFTS"], limits: {}, quotas: {} });
      await setWorkspaceSubscription(db(), fresh.context, { planVersionId, state: "ACTIVE" });
      const colleague = await createTestUser(db(), "capacity-solo-colleague");

      // The ceiling is absent, which `capacityVerdict` treats as genuinely uncapped — so without the
      // feature check this plan would admit an unlimited team.
      await expect(
        addWorkspaceMember(db(), fresh.context, { userId: colleague, role: "ADMIN", businessProfileScope: "ALL" }, NOW),
      ).rejects.toThrow(/MULTI_MEMBER/u);
    }, 180_000);

    it("refuses the seat after the last one the plan sells", async () => {
      const fresh = await freshWorkspace("two-seats");
      const planVersionId = await planWith("capacity-two-seats", { features: ["MULTI_MEMBER"], limits: { SEATS: 2 }, quotas: {} });
      await setWorkspaceSubscription(db(), fresh.context, { planVersionId, state: "ACTIVE" });
      const second = await createTestUser(db(), "capacity-seat-second");
      const third = await createTestUser(db(), "capacity-seat-third");

      // The owner is the first seat, so the second member fits and the third does not.
      await expect(
        addWorkspaceMember(db(), fresh.context, { userId: second, role: "ADMIN", businessProfileScope: "ALL" }, NOW),
      ).resolves.toMatchObject({ workspaceMemberId: expect.anything() as unknown });
      await expect(
        addWorkspaceMember(db(), fresh.context, { userId: third, role: "ADMIN", businessProfileScope: "ALL" }, NOW),
      ).rejects.toThrow(/SEATS/u);
      expect(await db().workspaceMember.count({ where: { workspaceId: fresh.workspaceId } })).toBe(2);
    }, 180_000);

    it("refuses connecting a channel the plan does not sell", async () => {
      const fresh = await freshWorkspace("no-whatsapp");
      const planVersionId = await planWith("capacity-instagram-only", { features: ["INSTAGRAM"], limits: {}, quotas: {} });
      await setWorkspaceSubscription(db(), fresh.context, { planVersionId, state: "ACTIVE" });
      const profile = await createBusinessProfile(db(), fresh.context, { name: "Channels" }, NOW);
      const profileContext = await authorizeBusinessProfileAccess(db(), {
        userId: fresh.ownerUserId,
        workspaceId: fresh.workspaceId,
        businessProfileId: profile.businessProfileId,
      });

      await expect(
        connectChannelAccount(
          db(),
          profileContext,
          {
            channel: "WHATSAPP",
            externalAccountId: "wa-account-unsold",
            capabilities: { ...NO_CAPABILITIES, text: true },
            credentialId: "cred-unsold",
          },
          NOW,
        ),
      ).rejects.toThrow(/not_entitled/u);
      // The one it does sell is unaffected, which is what keeps the refusal about the channel rather than
      // about the workspace.
      expect(await db().channelAccount.count({ where: { workspaceId: fresh.workspaceId } })).toBe(0);
    }, 180_000);

    it("lets a workspace with no plan connect its first channel", async () => {
      // Same reasoning as the first Business Profile: this is the act that starts a trial.
      const fresh = await freshWorkspace("pretrial-channel");
      // A real credential row, because the account references one by foreign key. Its contents are
      // irrelevant here — what is under test is the gate in front of the connect, not the cipher.
      const credential = await db().channelCredential.create({
        data: {
          workspaceId: fresh.workspaceId,
          keyId: "test-key",
          algorithm: "aes-256-gcm",
          ciphertext: Buffer.from("not-a-real-token"),
          nonce: Buffer.alloc(12, 1),
          authTag: Buffer.alloc(16, 2),
        },
        select: { id: true },
      });
      const profile = await createBusinessProfile(db(), fresh.context, { name: "First" }, NOW);
      const profileContext = await authorizeBusinessProfileAccess(db(), {
        userId: fresh.ownerUserId,
        workspaceId: fresh.workspaceId,
        businessProfileId: profile.businessProfileId,
      });

      await expect(
        connectChannelAccount(
          db(),
          profileContext,
          {
            channel: "INSTAGRAM",
            externalAccountId: "ig-account-pretrial",
            capabilities: { ...NO_CAPABILITIES, text: true },
            credentialId: credential.id,
          },
          NOW,
        ),
      ).resolves.toMatchObject({ channel: "INSTAGRAM" });
    }, 180_000);
  });
});

