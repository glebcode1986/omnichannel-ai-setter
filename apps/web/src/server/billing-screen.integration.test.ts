/**
 * The billing screen's own assembly, against a real database (#42).
 *
 * It drives `assembleBillingScreen` rather than reissuing its reads, for the reason the Style screen
 * learned the hard way: a helper that rebuilt the loader's queries would pass against a loader that had
 * stopped reading one of them.
 *
 * The cases worth writing are the ones where a billing page would mislead somebody about their own
 * account — and the one the spec is most insistent about: a browser coming back from a provider claiming
 * success must not move anything.
 */
import {
  createBusinessProfile,
  grantUsageTopUp,
  publishAcceptedCatalog,
  publishPlanVersion,
  reserveUsage,
  setWorkspaceAddOn,
  setWorkspaceSubscription,
  type PublishedCatalog,
} from "@omnichannel/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assembleBillingScreen, checkoutAvailable } from "./billing-screen";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { createPaidWorkspace } from "./testing/paid-workspace";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const DAY = 86_400_000;
const BASE = "/workspaces/ws/profiles/bp/settings/billing";

describe.skipIf(!databaseTestsEnabled())("the billing screen", () => {
  let database: TestDatabase;
  let catalog: PublishedCatalog;
  let sequence = 0;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    catalog = await publishAcceptedCatalog(database.db);
  }, 300_000);

  afterAll(async () => {
    await database?.dispose();
  });

  const db = () => database.db;

  /** A workspace, its owner's context, and an admin's — the three things every case below needs. */
  const workspace = async (label: string, planCode = "growth") => {
    sequence += 1;
    const made = await createPaidWorkspace(db(), `billing-${label}-${String(sequence)}`);
    const plan = catalog.plans.find((entry) => entry.code === planCode);
    await setWorkspaceSubscription(db(), made.owner, { planVersionId: plan?.planVersionId ?? "", state: "ACTIVE", periodEndsAt: new Date(NOW.getTime() + 20 * DAY) });
    return made;
  };

  const screen = async (made: Awaited<ReturnType<typeof workspace>>, query: Record<string, string> = {}, who = made.owner) =>
    assembleBillingScreen(db(), who, query, BASE, NOW);

  describe("who may act", () => {
    it("offers management to the owner", async () => {
      const made = await workspace("owner");

      expect((await screen(made)).canManage).toBe(true);
    }, 300_000);

    it("does not offer it to an admin, whose own request the store would refuse anyway", async () => {
      const made = await workspace("admin");

      // Convenience, never the boundary: `BILLING_ENTITLEMENTS.md` says UI hiding is not the security
      // decision, and the store refuses an admin whatever this answers.
      expect((await screen(made, {}, made.admin)).canManage).toBe(false);
    }, 300_000);
  });

  it("shows one workspace nothing of another's", async () => {
    const mine = await workspace("isolation-mine", "starter");
    const theirs = await workspace("isolation-theirs", "scale");

    const data = await screen(mine);

    expect(data.overview.subscription?.planCode).toBe("starter");
    expect(JSON.stringify(data)).not.toContain(theirs.workspaceId);
  }, 300_000);

  describe("coming back from a provider", () => {
    it("reports a confirmation as pending and moves nothing", async () => {
      const made = await workspace("checkout-success", "starter");

      const data = await screen(made, { checkout: "success" });

      // The property the spec is most insistent about: a browser return URL never grants entitlement. The
      // plan is still Starter, and the page has only been told to say that a confirmation is on its way.
      expect(data.checkoutReturn).toBe("success");
      expect(data.overview.subscription?.planCode).toBe("starter");
      expect(data.offers.filter((offer) => offer.current).map((offer) => offer.code)).toEqual(["starter"]);
    }, 300_000);

    it("ignores a return value nobody defined, rather than echoing it", async () => {
      const made = await workspace("checkout-unknown");

      // A query parameter is attacker-controlled, and echoing an unknown one would render a stranger's
      // text inside the shell.
      expect((await screen(made, { checkout: "<script>" })).checkoutReturn).toBeUndefined();
    }, 300_000);

    it("says checkout is unavailable until a provider adapter exists", async () => {
      const made = await workspace("checkout-unavailable");

      // Honest rather than hopeful: an upgrade needs authoritative confirmation that money moved, and a
      // button that could not produce one would be a button that lies.
      //
      // Derived rather than a constant since #47: a hard-coded `false` made the whole acceptance surface
      // unreachable however a deployment was configured, and left somebody to remember to edit a file on
      // the day an adapter landed.
      expect((await screen(made)).checkoutAvailable).toBe(false);
      expect(await checkoutAvailable(database.db)).toBe(false);
    }, 300_000);

    it("offers the acceptance step at its own path, so the offers do not rebuild it", async () => {
      const made = await workspace("checkout-path");

      expect((await screen(made)).checkoutPath).toMatch(/\/settings\/billing\/checkout$/u);
    }, 300_000);
  });

  it("shows the state the server has after a change the browser never saw", async () => {
    const made = await workspace("stale", "growth");
    const before = await screen(made);
    expect(before.overview.subscription?.state).toBe("ACTIVE");

    // What a billing webhook does: the subscription moves underneath an open page.
    await setWorkspaceSubscription(db(), made.owner, {
      planVersionId: catalog.plans.find((entry) => entry.code === "growth")?.planVersionId ?? "",
      state: "PAST_DUE",
      periodEndsAt: new Date(NOW.getTime() + 20 * DAY),
    });

    // The next read is the server's answer, not the one the browser is holding. A page that cached the
    // first would be showing an account state that stopped being true.
    expect((await screen(made)).overview.subscription?.state).toBe("PAST_DUE");
  }, 300_000);

  it("reports an expired trial as unable to do paid work while still naming the plan", async () => {
    sequence += 1;
    const made = await createPaidWorkspace(db(), `billing-trial-${String(sequence)}`);
    await setWorkspaceSubscription(db(), made.owner, {
      planVersionId: catalog.plans.find((entry) => entry.code === "growth")?.planVersionId ?? "",
      state: "TRIALING",
      trialEndsAt: new Date(NOW.getTime() - DAY),
    });

    const data = await screen(made);

    expect(data.overview.access.paidWorkAllowed).toBe(false);
    expect(data.overview.subscription?.state).toBe("TRIALING");
    // "Your trial ended" and "your plan excludes this" are different sentences, so the plan still says
    // what it says.
    expect(data.overview.entitlement.features.AUTOPILOT).toBe(true);
  }, 300_000);

  describe("allowances", () => {
    it("warns before exhaustion and reports exhaustion as its own state", async () => {
      sequence += 1;
      const made = await createPaidWorkspace(db(), `billing-allowance-${String(sequence)}`);
      const tiny = await publishPlanVersion(db(), {
        code: `billing-tiny-${String(sequence)}`,
        name: "Tiny",
        availability: "PRIVATE",
        grants: { features: ["VOICE_TRANSCRIPTION"], limits: {}, quotas: { VOICE_TRANSCRIPTION_SECONDS: 100 } },
      });
      await setWorkspaceSubscription(db(), made.owner, { planVersionId: tiny.planVersionId, state: "ACTIVE" });
      await reserveUsage(db(), {
        workspaceId: made.workspaceId,
        metric: "VOICE_TRANSCRIPTION_SECONDS",
        usageOperationId: `billing-warn-${String(sequence)}`,
        amount: 95,
        at: NOW,
      });

      const warned = (await screen(made)).overview.allowances[0];
      expect(warned).toMatchObject({ remaining: 5, health: "WARNING" });

      await reserveUsage(db(), {
        workspaceId: made.workspaceId,
        metric: "VOICE_TRANSCRIPTION_SECONDS",
        usageOperationId: `billing-exhaust-${String(sequence)}`,
        amount: 5,
        at: NOW,
      });
      expect((await screen(made)).overview.allowances[0]).toMatchObject({ remaining: 0, health: "EXHAUSTED" });
    }, 300_000);

    it("shows a bought balance beside the included one", async () => {
      const made = await workspace("topup", "starter");
      await grantUsageTopUp(db(), made.owner, {
        metric: "VOICE_TRANSCRIPTION_SECONDS",
        amount: 1_800,
        purchasedAt: NOW,
        expiresAt: new Date(NOW.getTime() + 40 * DAY),
      });

      const voice = (await screen(made)).overview.allowances[0];

      expect(voice).toMatchObject({ included: 300 * 60, purchased: 1_800 });
      expect(voice?.purchaseExpiresAt).toBeDefined();
    }, 300_000);
  });

  describe("what a plan change would cost", () => {
    it("names the resources that would exceed a smaller plan", async () => {
      const made = await workspace("downgrade", "scale");
      // Four profiles on Scale, which allows ten. Starter allows one.
      for (const name of ["Second", "Third", "Fourth"]) {
        await createBusinessProfile(db(), made.owner, { name }, NOW);
      }

      const starter = (await screen(made)).offers.find((offer) => offer.code === "starter");

      // The accepted behaviour: nothing is deleted and the person is shown what exceeds the new limits,
      // with the numbers, because they are the ones who choose what stays active. Every excess at once,
      // not the first one found — an owner who fixed the profiles and came back to discover the seats
      // were also over would have been told half the truth.
      expect(starter?.consequences.overCapacity).toEqual([
        { limit: "BUSINESS_PROFILES", inUse: 4, ceiling: 1 },
        { limit: "SEATS", inUse: 2, ceiling: 1 },
      ]);
      expect(starter?.consequences.clean).toBe(false);
    }, 300_000);

    it("says a move costs nothing when it costs nothing", async () => {
      const made = await workspace("clean-move", "starter");

      const scale = (await screen(made)).offers.find((offer) => offer.code === "scale");

      // Every accepted tier sells the same features, so an upgrade from Starter loses nothing — and
      // warning about nothing would talk somebody out of a change that was free.
      expect(scale?.consequences).toMatchObject({ clean: true, overCapacity: [], losingFeatures: [] });
    }, 300_000);

    it("counts capacity a bought add-on added, so a downgrade is judged against what is really in use", async () => {
      const made = await workspace("addon-downgrade", "starter");
      const extra = catalog.addOns.find((entry) => entry.code === "extra-business-profile");
      await setWorkspaceAddOn(db(), made.owner, { addOnVersionId: extra?.addOnVersionId ?? "", quantity: 2, activeFrom: NOW });
      await createBusinessProfile(db(), made.owner, { name: "Second" }, NOW);

      const data = await screen(made);

      expect(data.overview.capacity.find((entry) => entry.limit === "BUSINESS_PROFILES")).toEqual({
        limit: "BUSINESS_PROFILES",
        inUse: 2,
        ceiling: 3,
      });
      // Starter without the add-on allows one profile, and two exist. The owner and the admin are two
      // seats against Starter's one, which is reported in the same breath.
      expect(data.offers.find((offer) => offer.code === "starter")?.consequences.overCapacity).toEqual([
        { limit: "BUSINESS_PROFILES", inUse: 2, ceiling: 1 },
        { limit: "SEATS", inUse: 2, ceiling: 1 },
      ]);
    }, 300_000);
  });

  it("hands no provider identifier to the page", async () => {
    const made = await workspace("no-leak");

    // The read model copies an amount and a currency and drops the provider's own price object. A value
    // that reaches a page can reach a view-source, so the absence is structural rather than a convention.
    expect(JSON.stringify(await screen(made))).not.toContain("providerPriceId");
  }, 300_000);
});
