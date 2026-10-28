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
import { featureAllowed, NO_CAPABILITIES, withinLimit } from "@omnichannel/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ACCEPTED_ADDONS,
  ACCEPTED_CURRENCY,
  ACCEPTED_PLANS,
  ACCEPTED_TRIAL,
  ensureWorkspaceTrial,
  publishAcceptedCatalog,
  TRIAL_PLAN_CODE,
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
import { searchAuditEvents } from "./audit-store";
import { DbInputError, PlanLimitError } from "./errors";
import { readWorkspaceOnboarding } from "./onboarding-entry";
import { connectChannelAccount } from "./repositories/channel-accounts";
import {
  addWorkspaceMember,
  createBusinessProfile,
  createWorkspaceOnce,
  createWorkspaceWithOwner,
  NAME_MAX_LENGTH,
} from "./repositories/workspaces";
import { authorizeBusinessProfileAccess, authorizeWorkspaceAccess, type BusinessProfileContext } from "./tenancy";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { createTestUser, seedWorkspace, type SeededWorkspace } from "./testing/fixtures";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const MINUTE = 60;
const DAY_MS = 24 * 60 * 60 * 1_000;

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

  /**
   * The accepted no-card trial, from the act that starts it (#44, P6-07).
   *
   * These cases exist because of a defect with no failing test anywhere: `ACCEPTED_TRIAL` had been product
   * configuration for two phases, no code read it, no plan version expressed its grants, and the only
   * production writer of `workspace_subscriptions` was the settlement path — which pins `ACTIVE`. Two
   * comments in `repositories/` already described connecting a profile as "the act which starts its
   * trial". So a real workspace connected a channel, got no subscription at all, and `readEntitlement`
   * answered `INACTIVE` with no grants: every paid capability off before anybody had been asked for money.
   *
   * Trial *expiry* was already well covered, which is exactly how the missing start stayed invisible — a
   * suite can prove in detail what happens at the end of something that never begins.
   *
   * So these cases start where a business starts: a workspace, a profile, a channel connected. Nothing
   * here hand-writes a subscription row.
   */
  describe("the accepted no-card trial", () => {
    /** A business as far as the product makes one: a workspace, an owner, a profile. No subscription. */
    const business = async (label: string) => {
      sequence += 1;
      const owner = await createTestUser(db(), `trial-${label}-${String(sequence)}`);
      const { workspaceId } = await createWorkspaceWithOwner(db(), { name: `Trial ${label} ${String(sequence)}`, ownerUserId: owner });
      const workspace = await authorizeWorkspaceAccess(db(), { userId: owner, workspaceId });
      const created = await createBusinessProfile(db(), workspace, { name: "Main" });
      const profile = await authorizeBusinessProfileAccess(db(), { userId: owner, workspaceId, businessProfileId: created.businessProfileId });
      return { workspace, profile };
    };

    /** A stored credential envelope, because the account's reference to one is a foreign key. */
    const credential = async (workspaceId: string) =>
      (
        await db().channelCredential.create({
          data: {
            workspaceId,
            keyId: "trial-test-key",
            algorithm: "aes-256-gcm",
            ciphertext: Buffer.from("not a real token"),
            nonce: Buffer.alloc(12, 1),
            authTag: Buffer.alloc(16, 2),
          },
          select: { id: true },
        })
      ).id;

    /** The production connect path: both Instagram and WhatsApp onboarding go through this function. */
    const connect = async (profile: BusinessProfileContext, suffix: string, channel: "INSTAGRAM" | "WHATSAPP" = "INSTAGRAM", at = NOW) =>
      connectChannelAccount(
        db(),
        profile,
        {
          channel,
          externalAccountId: `${channel.toLowerCase()}-trial-${suffix}`,
          displayName: `Trial ${suffix}`,
          capabilities: { ...NO_CAPABILITIES, text: true },
          credentialId: await credential(profile.workspaceId),
        },
        at,
      );

    it("is published as a real version nobody can buy", async () => {
      // A plan version rather than a special case in the reader, so every capacity check and every usage
      // reservation answers for it without knowing it is a trial. `PRIVATE`, because it is not for sale.
      const version = await db().planVersion.findFirst({
        where: { plan: { code: TRIAL_PLAN_CODE } },
        orderBy: { version: "desc" },
        select: { id: true, availability: true, prices: { select: { currency: true } } },
      });

      expect(version?.id).toBe(published.trial.planVersionId);
      expect(version?.availability).toBe("PRIVATE");
      expect(version?.prices).toEqual([]);
      // And it is not among the plans the catalogue offers.
      expect(published.plans.map((plan) => plan.code)).not.toContain(TRIAL_PLAN_CODE);
    }, 120_000);

    it("starts when a profile is first connected, and grants exactly what the accepted trial says", async () => {
      const { workspace, profile } = await business("grants");

      // Before: a business with nothing bought and nothing connected is entitled to nothing, and the
      // capacity check can tell that from a plan that chose zero.
      expect(await readEntitlement(db(), workspace.workspaceId, NOW)).toMatchObject({
        state: "INACTIVE",
        subscribed: false,
        paidWorkAllowed: false,
      });

      await connect(profile, "grants");

      const after = await readEntitlement(db(), workspace.workspaceId, NOW);
      expect(after).toMatchObject({ state: "TRIALING", planCode: TRIAL_PLAN_CODE, subscribed: true, paidWorkAllowed: true });
      // The accepted numbers, read back through the entitlement rather than from the constant.
      expect(after.limits.BUSINESS_PROFILES).toBe(ACCEPTED_TRIAL.businessProfiles);
      expect(after.limits.SEATS).toBe(ACCEPTED_TRIAL.seats);
      expect(after.quotas.VOICE_TRANSCRIPTION_SECONDS).toBe(ACCEPTED_TRIAL.voiceTranscriptionMinutes * MINUTE);
      // Core features, so a trial can actually be tried: drafting, autopilot, both channels, voice.
      for (const feature of ["AI_DRAFTS", "AUTOPILOT", "INSTAGRAM", "WHATSAPP", "VOICE_TRANSCRIPTION"] as const) {
        expect(featureAllowed(after, feature), feature).toBe(true);
      }
      // And the ceilings bite: one profile means the second is refused, by the same check a paid tier uses.
      expect(withinLimit(after, "BUSINESS_PROFILES", 1)).toBe(false);
      expect(withinLimit(after, "SEATS", 2)).toBe(true);
    }, 120_000);

    it("ends fourteen days later, to the hour it started", async () => {
      const { workspace, profile } = await business("fourteen");

      await connect(profile, "fourteen");

      const subscription = await db().workspaceSubscription.findUnique({
        where: { workspaceId: workspace.workspaceId },
        select: { state: true, trialEndsAt: true, periodEndsAt: true, graceStartedAt: true, canceledAt: true },
      });
      expect(subscription?.trialEndsAt).toEqual(new Date(NOW.getTime() + ACCEPTED_TRIAL.days * DAY_MS));
      // Nothing else is claimed: there is no paid period, no grace and no cancellation.
      expect(subscription).toMatchObject({ state: "TRIALING", periodEndsAt: null, graceStartedAt: null, canceledAt: null });

      // A minute before the end it still works; a minute after, paid work stops without anything being
      // written — which is what makes a trial end on time rather than when a job gets round to it.
      const endsAt = subscription?.trialEndsAt ?? NOW;
      expect((await readEntitlement(db(), workspace.workspaceId, new Date(endsAt.getTime() - 60_000))).paidWorkAllowed).toBe(true);
      expect((await readEntitlement(db(), workspace.workspaceId, new Date(endsAt.getTime() + 60_000))).paidWorkAllowed).toBe(false);
    }, 120_000);

    it("starts exactly once, however many channels a profile connects", async () => {
      const { workspace, profile } = await business("once");

      await connect(profile, "once");
      const first = await db().workspaceSubscription.findUnique({
        where: { workspaceId: workspace.workspaceId },
        select: { id: true, trialEndsAt: true },
      });

      // A second channel, a day later — WhatsApp, because one profile speaks for one account per channel.
      // A trial that restarted here would be a business getting fourteen fresh days for every channel.
      await connect(profile, "once", "WHATSAPP", new Date(NOW.getTime() + DAY_MS));
      const second = await db().workspaceSubscription.findUnique({
        where: { workspaceId: workspace.workspaceId },
        select: { id: true, trialEndsAt: true },
      });

      expect(second?.id).toBe(first?.id);
      expect(second?.trialEndsAt).toEqual(first?.trialEndsAt);
      expect(await db().workspaceSubscription.count({ where: { workspaceId: workspace.workspaceId } })).toBe(1);
    }, 120_000);

    it("cannot be started twice by two connections at the same moment", async () => {
      const { workspace } = await business("race");

      // Two concurrent calls, which is what two browser tabs finishing an onboarding flow look like. The
      // guarantee is the unique workspace and `ON CONFLICT DO NOTHING`, so there is no read-then-write for
      // the two to interleave inside — and neither call throws.
      const [left, right] = await Promise.all([
        ensureWorkspaceTrial(db(), workspace.workspaceId, NOW),
        ensureWorkspaceTrial(db(), workspace.workspaceId, new Date(NOW.getTime() + 5_000)),
      ]);

      expect([left.started, right.started].filter(Boolean)).toHaveLength(1);
      expect(await db().workspaceSubscription.count({ where: { workspaceId: workspace.workspaceId } })).toBe(1);
    }, 120_000);

    it("never restarts for a workspace that has moved on, whatever its state", async () => {
      const growth = published.plans.find((plan) => plan.code === "growth");
      if (growth === undefined) {
        throw new Error("the accepted catalogue has no growth plan");
      }
      // Each state carries the dates its own CHECK requires: `GRACE` has a start, and a cancelled
      // subscription has both a cancellation and the period it is running out.
      const clock = (state: string) =>
        state === "GRACE"
          ? { graceStartedAt: NOW }
          : state === "CANCELED_PENDING_END"
            ? { canceledAt: NOW, periodEndsAt: new Date(NOW.getTime() + 7 * DAY_MS) }
            : {};

      for (const state of ["ACTIVE", "PAST_DUE", "GRACE", "CANCELED_PENDING_END", "INACTIVE"] as const) {
        const { workspace } = await business(`moved-${state.toLowerCase()}`);
        await setWorkspaceSubscription(db(), workspace, { planVersionId: growth.planVersionId, state, ...clock(state) });

        const outcome = await ensureWorkspaceTrial(db(), workspace.workspaceId, NOW);

        // Including `INACTIVE`: a workspace whose trial ran out and was never paid for must not be handed
        // another one by reconnecting a channel.
        expect(outcome.started, state).toBe(false);
        const subscription = await db().workspaceSubscription.findUnique({
          where: { workspaceId: workspace.workspaceId },
          select: { state: true, trialEndsAt: true },
        });
        expect(subscription?.state, state).toBe(state);
        expect(subscription?.trialEndsAt, state).toBeNull();
      }
    }, 180_000);

    it("records the start once, in the product's own words", async () => {
      const { workspace, profile } = await business("audited");

      await connect(profile, "audited");
      await connect(profile, "audited", "WHATSAPP");

      const audits = (await searchAuditEvents(db(), workspace, { kinds: ["SUBSCRIPTION_CHANGED"] })).rows;
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ kind: "SUBSCRIPTION_CHANGED", subjectType: "Workspace", subjectId: workspace.workspaceId });
      expect(audits[0]?.summary).toContain(String(ACCEPTED_TRIAL.days));
      // No provider identifier and no amount: nothing was charged, and the trail stays readable after the
      // provider is replaced.
      const detail = JSON.stringify(audits[0]?.detail ?? {});
      expect(detail).toContain("TRIALING");
      expect(detail).toContain(TRIAL_PLAN_CODE);
      expect(detail).not.toContain("price_");
      expect(detail).not.toContain("cus_");
    }, 120_000);

    /**
     * What the front door is allowed to say about all of this (#115).
     *
     * The trial's *mechanism* is covered above. These cases are about the sentence a screen builds from
     * it, which is a separate thing and the one a customer actually reads. `ensureWorkspaceTrial` answers
     * `started: false` for two unrelated facts — already subscribed, and no trial plan published — so a
     * page driven by that boolean alone is guaranteed to be wrong in one of the two cases.
     */
    describe("as the front door reports it", () => {
      it("says the trial is awaiting a first connection, and then reads its end from the row", async () => {
        const { workspace, profile } = await business("entry");

        const before = await readWorkspaceOnboarding(db(), workspace, NOW);
        expect(before.trial).toEqual({ noTrialReason: "AWAITING_FIRST_CONNECTION" });
        expect(before.profiles).toHaveLength(1);
        expect(before.profiles[0]).toMatchObject({ name: "Main", status: "SETUP", connectedChannels: [] });

        await connect(profile, "entry");

        const after = await readWorkspaceOnboarding(db(), workspace, NOW);
        const row = await db().workspaceSubscription.findUnique({
          where: { workspaceId: workspace.workspaceId },
          select: { trialEndsAt: true },
        });
        // Read from the row, not computed from the connection date. If the catalogue is published after a
        // workspace has already connected, the trial starts on the *next* connect and is dated from that
        // moment — a page that recomputed it from the connection would state a window nobody is on.
        expect(after.trial).toEqual({ subscriptionState: "TRIALING", planCode: TRIAL_PLAN_CODE, trialEndsAt: row?.trialEndsAt });
        expect(after.trial.trialEndsAt).toEqual(new Date(NOW.getTime() + ACCEPTED_TRIAL.days * DAY_MS));
        // And the profile now reports the channel it speaks on, which is the other half of the question.
        expect(after.profiles[0]?.connectedChannels).toEqual(["INSTAGRAM"]);
      }, 120_000);

      it("reports a channel that was disconnected as absent, because that is what decides the next connect", async () => {
        const { workspace, profile } = await business("disconnected");
        const account = await connect(profile, "disconnected");
        await db().channelAccount.update({
          where: { workspaceId_businessProfileId_id: { workspaceId: profile.workspaceId, businessProfileId: profile.businessProfileId, id: account.id } },
          data: { status: "DISCONNECTED" },
        });

        const state = await readWorkspaceOnboarding(db(), workspace, NOW);

        expect(state.profiles[0]?.connectedChannels).toEqual([]);
        // The trial is untouched by a disconnection: it started, and nothing restarts or revokes it.
        expect(state.trial).toMatchObject({ subscriptionState: "TRIALING" });
      }, 120_000);

      it("refuses the second Business Profile a trialling workspace asks for, by the plan's own ceiling", async () => {
        // Not an edge case: `ACCEPTED_TRIAL.businessProfiles` is 1, so this is what the second profile does
        // during every trial. The front door renders it as a plan limit rather than as a fault.
        const { workspace, profile } = await business("ceiling");
        await connect(profile, "ceiling");

        await expect(createBusinessProfile(db(), workspace, { name: "Second" }, NOW)).rejects.toBeInstanceOf(PlanLimitError);
        // And the first is still the only one, so the refusal happened before the insert rather than after.
        expect(await db().businessProfile.count({ where: { workspaceId: workspace.workspaceId } })).toBe(1);
      }, 120_000);

      it("creates one Business Profile when two submissions race for the plan's last slot", async () => {
        // The case `policy-store.integration.test.ts` records as unclosed: its concurrent create runs on a
        // workspace with no ceiling, so `serializeCapacity` could be deleted from `createBusinessProfile`
        // and nothing would fail. This is the shape where the lock is the only thing standing between a
        // one-profile plan and two profiles — **zero** existing profiles and a ceiling of one, so both
        // transactions count nothing and both would insert.
        //
        // Not a `pg_locks` observer, which is what that note asks for and what would prove the lock is
        // *held*; this proves the behaviour the lock exists to produce, which no test asserted before.
        const owner = await createTestUser(db(), `slot-${String((sequence += 1))}`);
        const { workspaceId } = await createWorkspaceWithOwner(db(), { name: `Last Slot ${String(sequence)}`, ownerUserId: owner });
        const workspace = await authorizeWorkspaceAccess(db(), { userId: owner, workspaceId });
        const starter = published.plans.find((plan) => plan.code === "starter");
        expect(starter, "the accepted catalogue publishes a one-profile tier").toBeDefined();
        await setWorkspaceSubscription(db(), workspace, { planVersionId: starter?.planVersionId ?? "", state: "ACTIVE" });
        expect(await readEntitlement(db(), workspaceId, NOW)).toMatchObject({ limits: { BUSINESS_PROFILES: 1 } });

        const outcomes = await Promise.allSettled([
          createBusinessProfile(db(), workspace, { name: "Race A" }, NOW),
          createBusinessProfile(db(), workspace, { name: "Race B" }, NOW),
        ]);

        expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
        const refused = outcomes.find((outcome) => outcome.status === "rejected");
        expect(refused?.status === "rejected" ? refused.reason : undefined).toBeInstanceOf(PlanLimitError);
        // The fact that matters: the plan's ceiling held under concurrency, not merely in sequence.
        expect(await db().businessProfile.count({ where: { workspaceId } })).toBe(1);
      }, 120_000);

      it("shows a member only the profiles they were granted, and the channels of those", async () => {
        const { workspace, profile } = await business("scoped");
        await connect(profile, "scoped");
        const second = await createBusinessProfile(db(), workspace, { name: "Other" }, NOW);
        const agentId = await createTestUser(db(), `scoped-agent-${String(sequence)}`);
        await addWorkspaceMember(db(), workspace, {
          userId: agentId,
          role: "AGENT",
          businessProfileScope: { selected: [second.businessProfileId] },
        });
        const agent = await authorizeWorkspaceAccess(db(), { userId: agentId, workspaceId: workspace.workspaceId });

        const asAgent = await readWorkspaceOnboarding(db(), agent, NOW);

        // The connected profile is not theirs, so neither it nor its channel is visible. Deriving the
        // channel rows from the workspace instead of from the authorized profiles would have leaked the
        // existence of a profile this member may not see.
        expect(asAgent.profiles.map((entry) => entry.name)).toEqual(["Other"]);
        expect(asAgent.profiles[0]?.connectedChannels).toEqual([]);
      }, 120_000);
    });

    /**
     * Submitting the creation form twice (#115).
     *
     * A workspace cannot be deleted, so a duplicate is permanent. The guarantee is an advisory lock taken
     * inside the same transaction as the insert; a check-then-insert without one loses exactly the race it
     * is meant to stop, which is why the concurrent case below is run with `Promise.all` rather than in
     * sequence — a sequential pair passes with no lock at all.
     */
    describe("creating a workspace twice", () => {
      it("creates one workspace and reports the second submission as a replay", async () => {
        const owner = await createTestUser(db(), `once-${String((sequence += 1))}`);
        const name = `Double Click ${String(sequence)}`;

        const first = await createWorkspaceOnce(db(), { name, ownerUserId: owner });
        const second = await createWorkspaceOnce(db(), { name, ownerUserId: owner });

        expect(first.replayed).toBe(false);
        expect(second.replayed).toBe(true);
        expect(second.workspace.workspaceId).toBe(first.workspace.workspaceId);
        expect(await db().workspace.count({ where: { name } })).toBe(1);
      }, 120_000);

      it("creates one workspace when both submissions arrive at the same moment", async () => {
        const owner = await createTestUser(db(), `race-${String((sequence += 1))}`);
        const name = `Simultaneous ${String(sequence)}`;

        const [a, b] = await Promise.all([
          createWorkspaceOnce(db(), { name, ownerUserId: owner }),
          createWorkspaceOnce(db(), { name, ownerUserId: owner }),
        ]);

        // Exactly one insert, whichever order the two transactions were granted the lock in.
        expect([a.replayed, b.replayed].filter((replayed) => !replayed)).toHaveLength(1);
        expect(a.workspace.workspaceId).toBe(b.workspace.workspaceId);
        expect(await db().workspace.count({ where: { name } })).toBe(1);
      }, 120_000);

      it("normalizes before it compares, so padding cannot slip a duplicate past the check", async () => {
        const owner = await createTestUser(db(), `padded-${String((sequence += 1))}`);
        const name = `Padded ${String(sequence)}`;

        await createWorkspaceOnce(db(), { name, ownerUserId: owner });
        const padded = await createWorkspaceOnce(db(), { name: `   ${name}  `, ownerUserId: owner });

        expect(padded.replayed).toBe(true);
        expect(await db().workspace.count({ where: { name } })).toBe(1);
      }, 120_000);

      it("does not treat another owner's workspace of the same name as a replay", async () => {
        // Two businesses may legitimately both be called "Studio", and a member of somebody else's
        // "Studio" has not thereby created one.
        const name = `Studio ${String((sequence += 1))}`;
        const first = await createTestUser(db(), `studio-a-${String(sequence)}`);
        const second = await createTestUser(db(), `studio-b-${String(sequence)}`);

        const mine = await createWorkspaceOnce(db(), { name, ownerUserId: first });
        const theirs = await createWorkspaceOnce(db(), { name, ownerUserId: second });

        expect(theirs.replayed).toBe(false);
        expect(theirs.workspace.workspaceId).not.toBe(mine.workspace.workspaceId);
        expect(await db().workspace.count({ where: { name } })).toBe(2);
      }, 120_000);

      it("refuses a name the store would not have stored", async () => {
        const owner = await createTestUser(db(), `blank-${String((sequence += 1))}`);

        await expect(createWorkspaceOnce(db(), { name: "   ", ownerUserId: owner })).rejects.toBeInstanceOf(DbInputError);
        await expect(createWorkspaceOnce(db(), { name: "a".repeat(NAME_MAX_LENGTH + 1), ownerUserId: owner })).rejects.toBeInstanceOf(
          DbInputError,
        );
      }, 120_000);
    });
  });

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
