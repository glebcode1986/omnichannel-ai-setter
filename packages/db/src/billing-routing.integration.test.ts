/**
 * Seller profiles, routing, activation and acceptance (#46, ADR-019).
 *
 * The claims worth proving here are the ones whose failure costs money or gives the product away, and
 * most of them are claims that something does *not* happen:
 *
 * - a success page cannot activate a paid entitlement;
 * - a client cannot choose the provider, the provider account or the selling entity;
 * - a full payment that arrived after its quote expired does not activate;
 * - a redelivered webhook does not extend a term twice;
 * - a provider switch does not leave two providers billing one customer;
 * - a checkout cannot exist without the acceptance snapshot it was made under, and neither can be edited
 *   afterwards.
 *
 * Several of them are proved against raw SQL rather than through the store, because a rule that only the
 * store enforces is a rule a support script, a migration or next quarter's convenience helper walks past.
 */
import { BILLING_CAPABILITIES, money, periodEndFor } from "@omnichannel/domain";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { searchAuditEvents } from "./audit-store";
import {
  clearBillingProviders,
  reconcileProviderState,
  registerBillingProvider,
  verifyProviderDelivery,
  type NormalizedBillingEvent,
  type VerifiedBillingEvent,
} from "./billing-events";
import {
  attachProviderCheckoutReference,
  CHECKOUT_REFUSALS,
  expireStaleCheckouts,
  openCheckoutContract,
  publishLegalDocument,
  readArrangement,
  readBillingRoutes,
  readCheckoutOffer,
  readCheckoutRouting,
  recordVerifiedBillingEvent,
  upsertBillingRoute,
  upsertSellerProfile,
  type OpenCheckoutInput,
  type OpenedCheckout,
} from "./billing-routing-store";
import { publishPlanVersion, readEntitlement } from "./entitlement-store";
import { DbInputError } from "./errors";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { createTestUser } from "./testing/fixtures";
import { createWorkspaceWithOwner } from "./repositories/workspaces";
import { authorizeWorkspaceAccess, type WorkspaceContext } from "./tenancy";

const NOW = new Date("2026-10-07T12:00:00.000Z");

/**
 * A fifteen-minute offer to settle a EUR-priced plan in an asset.
 *
 * The catalogue's price book is ISO 4217 and stays that way — `plan_prices_currency_check` refuses an
 * asset code outright — so this is what "the adapter may quote in another asset without changing the plan"
 * actually looks like: a base of EUR 49.00 and a charge of 5.12 USDT with a clock on it.
 */
const usdtQuote = { charge: money(5_120_000, "USDT"), expiresAt: new Date("2026-10-07T12:15:00.000Z") };
const EVERY_CAPABILITY = [...BILLING_CAPABILITIES];

/** The adapter's own vocabulary, which only the adapter reads. Here it is an event identifier. */
const deliveries = new Map<string, NormalizedBillingEvent>();

describe.skipIf(!databaseTestsEnabled())("billing routing, seller profiles and acceptance (PostgreSQL)", () => {
  let database: TestDatabase;
  let planVersionId: string;
  let secondPlanVersionId: string;
  const db = () => database.db;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();

    await upsertSellerProfile(database.db, {
      code: "seller-ro",
      legalName: "Example SRL",
      displayName: "Example",
      jurisdiction: "RO",
      supportEmail: "billing@example.test",
      legalConfigRef: "config/ro",
    });
    await upsertSellerProfile(database.db, {
      code: "seller-mor",
      legalName: "Reseller Global Inc",
      displayName: "Reseller",
      jurisdiction: "US",
      supportEmail: "support@reseller.test",
    });

    await upsertBillingRoute(database.db, {
      code: "direct-eu",
      provider: "test-psp",
      providerAccountRef: "acct_direct",
      sellerProfileCode: "seller-ro",
      settlementModel: "DIRECT_PSP",
      capabilities: ["RECURRING_SUBSCRIPTIONS", "REFUNDS", "TAX_CALCULATION", "INVOICES", "VERIFIED_WEBHOOKS", "PRORATION"],
      currencies: ["EUR"],
      intervals: ["MONTH", "YEAR"],
      enabled: true,
      priority: 10,
    });
    await upsertBillingRoute(database.db, {
      code: "mor-global",
      provider: "test-mor",
      providerAccountRef: "acct_mor",
      sellerProfileCode: "seller-mor",
      settlementModel: "MERCHANT_OF_RECORD",
      capabilities: ["RECURRING_SUBSCRIPTIONS", "REFUNDS", "TAX_CALCULATION", "TAX_REMITTANCE", "INVOICES", "VERIFIED_WEBHOOKS"],
      currencies: ["EUR"],
      intervals: ["MONTH", "YEAR"],
      enabled: true,
      priority: 20,
    });
    await upsertBillingRoute(database.db, {
      code: "crypto-usdt",
      provider: "test-crypto",
      sellerProfileCode: "seller-ro",
      settlementModel: "CRYPTO_PROCESSOR",
      capabilities: ["PREPAID_TERM", "TIMED_QUOTES", "VERIFIED_WEBHOOKS", "AUTHORITATIVE_RECONCILIATION"],
      currencies: ["EUR"],
      intervals: ["MONTH", "YEAR"],
      enabled: true,
      priority: 30,
    });

    await publishLegalDocument(database.db, {
      kind: "TERMS_OF_SERVICE",
      locale: "en",
      contentRef: "https://legal.example.test/terms/en/1",
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    });
    await publishLegalDocument(database.db, {
      kind: "PUBLIC_OFFER",
      locale: "en",
      contentRef: "https://legal.example.test/offer/ro/en/1",
      sellerProfileCode: "seller-ro",
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    });
    await publishLegalDocument(database.db, {
      kind: "PUBLIC_OFFER",
      locale: "en",
      contentRef: "https://legal.example.test/offer/mor/en/1",
      sellerProfileCode: "seller-mor",
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    });
    // Published and not yet in force. Nothing should offer it or accept it.
    await publishLegalDocument(database.db, {
      kind: "PRIVACY_POLICY",
      locale: "en",
      contentRef: "https://legal.example.test/privacy/en/next",
      requiredForCheckout: false,
      effectiveFrom: new Date("2027-01-01T00:00:00.000Z"),
    });

    planVersionId = (
      await publishPlanVersion(database.db, {
        code: "routing-growth",
        name: "Growth",
        grants: { features: ["AI_DRAFTS", "INSTAGRAM"], limits: { BUSINESS_PROFILES: 3 }, quotas: {} },
        availability: "PUBLIC",
        prices: [
          { currency: "EUR", interval: "MONTH", amountCents: 4_900 },
          { currency: "EUR", interval: "YEAR", amountCents: 49_000 },
        ],
      })
    ).planVersionId;
    secondPlanVersionId = (
      await publishPlanVersion(database.db, {
        code: "routing-scale",
        name: "Scale",
        grants: { features: ["AI_DRAFTS", "AUTOPILOT", "INSTAGRAM", "WHATSAPP"], limits: {}, quotas: {} },
        availability: "PUBLIC",
        prices: [{ currency: "EUR", interval: "MONTH", amountCents: 9_900 }],
      })
    ).planVersionId;

    registerBillingProvider({
      provider: "test-psp",
      verify: (delivery) => (delivery.headers["x-signature"] === "good" ? deliveries.get(delivery.body) ?? null : null),
    });
    registerBillingProvider({
      provider: "test-mor",
      verify: (delivery) => (delivery.headers["x-signature"] === "good" ? deliveries.get(delivery.body) ?? null : null),
    });
    registerBillingProvider({
      provider: "test-crypto",
      verify: (delivery) => (delivery.headers["x-signature"] === "good" ? deliveries.get(delivery.body) ?? null : null),
      reconcile: (query) => Promise.resolve(deliveries.get(`reconcile:${query.providerReference}`) ?? null),
    });
  }, 120_000);

  afterAll(async () => {
    clearBillingProviders();
    await database?.dispose();
  });

  afterEach(() => {
    deliveries.clear();
  });

  let workspaceCounter = 0;

  /** A workspace with no subscription and no charge path: the state a first purchase starts from. */
  async function freshWorkspace(): Promise<{ readonly workspaceId: string; readonly context: WorkspaceContext; readonly ownerUserId: string }> {
    workspaceCounter += 1;
    const label = `routing-${String(workspaceCounter)}`;
    const ownerUserId = await createTestUser(db(), label);
    const { workspaceId } = await createWorkspaceWithOwner(db(), { name: `Workspace ${label}`, ownerUserId });
    const context = await authorizeWorkspaceAccess(db(), { userId: ownerUserId, workspaceId });
    return { workspaceId, context, ownerUserId };
  }

  /**
   * Accepts whatever the offer says is required, which is what the screen's control will do.
   *
   * Priced as a migration, so the ids can be read even for a workspace that already has a charge path —
   * the refusal that would otherwise come back is the subject of its own test rather than a thing every
   * other test has to work around.
   */
  async function acceptedIds(context: WorkspaceContext, input: Request): Promise<readonly string[]> {
    const offer = await readCheckoutOffer(db(), context, {
      planVersionId: input.planVersionId,
      interval: input.interval,
      arrangement: input.arrangement,
      currency: input.currency,
      locale: input.locale,
      supersedeCurrent: true,
      ...(input.market === undefined ? {} : { market: input.market }),
    });
    if (!offer.available) {
      throw new Error(`offer unavailable: ${offer.reason} ${offer.detail.join(", ")}`);
    }
    return offer.documents.filter((document) => document.requiredForCheckout).map((document) => document.legalDocumentId);
  }

  async function openFor(context: WorkspaceContext, input: Request): Promise<OpenedCheckout> {
    const opened = await openCheckoutContract(db(), context, { ...input, acceptedDocumentIds: await acceptedIds(context, input) });
    if (!opened.available) {
      throw new Error(`checkout refused: ${opened.reason} ${opened.detail.join(", ")}`);
    }
    return opened;
  }

  /** Mints a verified event the way production does: through an adapter, from a signed delivery. */
  function verified(provider: string, event: NormalizedBillingEvent): VerifiedBillingEvent {
    deliveries.set(event.providerEventId, event);
    const minted = verifyProviderDelivery({
      provider,
      body: event.providerEventId,
      headers: { "x-signature": "good" },
      receivedAt: NOW,
    });
    if (minted === null) {
      throw new Error("the stub adapter refused its own delivery");
    }
    return minted;
  }

  type Request = Omit<OpenCheckoutInput, "acceptedDocumentIds">;

  const request = (overrides: Partial<Request> = {}): Request => ({
    planVersionId,
    interval: "MONTH",
    arrangement: "RECURRING",
    currency: "EUR",
    locale: "en",
    at: NOW,
    ...overrides,
  });

  describe("the operator's configuration", () => {
    it("refuses an incoherent route with every fault, not the first", async () => {
      await expect(
        upsertBillingRoute(db(), {
          code: "broken-mor",
          provider: "test-psp",
          sellerProfileCode: "seller-mor",
          settlementModel: "MERCHANT_OF_RECORD",
          capabilities: ["RECURRING_SUBSCRIPTIONS", "VERIFIED_WEBHOOKS"],
          currencies: ["EUR", "USD"],
          intervals: ["MONTH"],
        }),
      ).rejects.toThrow(/MOR_WITHOUT_TAX_REMITTANCE.*MULTI_CURRENCY_UNDECLARED/u);
    });

    it("refuses the same row written by raw SQL, so the rule is not only the store's", async () => {
      await expect(
        db().$executeRawUnsafe(
          `INSERT INTO "billing_routes" ("id","code","provider","seller_profile_id","settlement_model","capabilities","currencies","intervals","enabled","updated_at")
           SELECT 'raw-mor','raw-mor','test-psp',"id",'MERCHANT_OF_RECORD',ARRAY['RECURRING_SUBSCRIPTIONS','VERIFIED_WEBHOOKS']::TEXT[],ARRAY['EUR']::TEXT[],ARRAY['MONTH']::"BillingInterval"[],true,NOW()
             FROM "seller_profiles" WHERE "code" = 'seller-mor'`,
        ),
      ).rejects.toThrow(/billing_routes_coherence_check/u);
    });

    it("accepts every capability the domain declares and refuses one it does not", async () => {
      // Both directions, so the CHECK's list and `BILLING_CAPABILITIES` cannot drift apart in silence —
      // the list is spelled twice and this is the only thing holding the two spellings together.
      await upsertBillingRoute(db(), {
        code: "all-capabilities",
        provider: "test-psp",
        sellerProfileCode: "seller-mor",
        settlementModel: "MERCHANT_OF_RECORD",
        capabilities: EVERY_CAPABILITY,
        currencies: ["EUR", "USD"],
        intervals: ["MONTH"],
        enabled: false,
      });

      // Coherent in every other way — it has an arrangement and an activation source — so the only
      // constraint it can violate is the one that lists the capabilities the product knows about.
      await expect(
        db().$executeRawUnsafe(
          `INSERT INTO "billing_routes" ("id","code","provider","seller_profile_id","settlement_model","capabilities","currencies","intervals","enabled","updated_at")
           SELECT 'raw-invented','raw-invented','test-psp',"id",'DIRECT_PSP',
                  ARRAY['RECURRING_SUBSCRIPTIONS','VERIFIED_WEBHOOKS','INVENTED_CAPABILITY']::TEXT[],
                  ARRAY['EUR']::TEXT[],ARRAY['MONTH']::"BillingInterval"[],false,NOW()
             FROM "seller_profiles" WHERE "code" = 'seller-ro'`,
        ),
      ).rejects.toThrow(/billing_routes_capabilities_known_check/u);
    });

    it("refuses an enabled route that could never make a payment a fact", async () => {
      // Neither a verified webhook nor an authoritative read. Nothing arriving on it could activate
      // anything, and a browser redirect is not a third option.
      await expect(
        upsertBillingRoute(db(), {
          code: "unverifiable",
          provider: "test-psp",
          sellerProfileCode: "seller-ro",
          settlementModel: "DIRECT_PSP",
          capabilities: ["RECURRING_SUBSCRIPTIONS"],
          currencies: ["EUR"],
          intervals: ["MONTH"],
          enabled: true,
        }),
      ).rejects.toThrow(/NO_ACTIVATION_SOURCE/u);
    });

    it("reads its routes back through the domain's own guards", async () => {
      const routes = await readBillingRoutes(db(), { enabledOnly: true });
      const codes = routes.map((route) => route.code);

      expect(codes).toContain("direct-eu");
      expect(codes).not.toContain("all-capabilities");
      const direct = routes.find((route) => route.code === "direct-eu");
      expect(direct?.capabilities).not.toContain("TAX_REMITTANCE");
      expect(direct?.intervals).toEqual(["MONTH", "YEAR"]);
    });
  });

  describe("choosing a route for a checkout", () => {
    it("takes the operator's preferred route and snapshots its selling entity", async () => {
      const { context } = await freshWorkspace();
      const opened = await openFor(context, request());

      expect(opened.seller.legalName).toBe("Example SRL");
      expect(opened.settlementModel).toBe("DIRECT_PSP");
      const contract = await db().checkoutContract.findUniqueOrThrow({
        where: { id: opened.checkoutContractId },
        select: { sellerLegalName: true, sellerJurisdiction: true, billingRoute: { select: { code: true } } },
      });
      expect(contract).toMatchObject({ sellerLegalName: "Example SRL", sellerJurisdiction: "RO", billingRoute: { code: "direct-eu" } });
    });

    it("ignores a client-supplied route, account or seller identifier", async () => {
      // The structural answer to "never trust client-supplied provider/account/entity identifiers": the
      // input has no such field, so a forged one has nowhere to arrive. Asserted anyway, because a later
      // convenience parameter would break it quietly.
      const { context } = await freshWorkspace();
      const forged = {
        ...request(),
        billingRouteId: "mor-global",
        sellerProfileId: "seller-mor",
        provider: "attacker",
        providerAccountRef: "acct_attacker",
      } as Omit<OpenCheckoutInput, "acceptedDocumentIds">;

      const opened = await openFor(context, forged);

      expect(opened.seller.legalName).toBe("Example SRL");
      const routing = await readCheckoutRouting(db(), opened.checkoutContractId);
      expect(routing).toEqual({ provider: "test-psp", providerAccountRef: "acct_direct", routeCode: "direct-eu" });
    });

    it("explains which route refused what when nothing admits the request", async () => {
      const { context } = await freshWorkspace();
      const offer = await readCheckoutOffer(db(), context, request({ currency: "GBP" }));

      expect(offer.available).toBe(false);
      if (!offer.available) {
        expect(offer.reason).toBe("NO_ROUTE");
        expect(offer.detail).toContain("direct-eu: CURRENCY_UNSUPPORTED");
      }
    });

    it("refuses a plan version the selected route's currency has no price for", async () => {
      const { context } = await freshWorkspace();
      const offer = await readCheckoutOffer(db(), context, request({ planVersionId: secondPlanVersionId, interval: "YEAR" }));

      expect(offer).toMatchObject({ available: false, reason: "NO_PRICE" });
    });

    it("is the owner's, not an admin's", async () => {
      const { workspaceId } = await freshWorkspace();
      const adminUserId = await createTestUser(db(), `routing-admin-${String(workspaceCounter)}`);
      await db().workspaceMember.create({ data: { workspaceId, userId: adminUserId, role: "ADMIN", businessProfileScope: "ALL" } });
      const admin = await authorizeWorkspaceAccess(db(), { userId: adminUserId, workspaceId });

      await expect(readCheckoutOffer(db(), admin, request())).rejects.toThrow(/open a checkout/u);
    });
  });

  describe("direct PSP and Merchant of Record", () => {
    it("normalize into the same entitlement, and differ only in who remits the tax", async () => {
      const direct = await freshWorkspace();
      const viaMor = await freshWorkspace();

      const directOffer = await readCheckoutOffer(db(), direct.context, request());
      await db().billingRoute.update({ where: { code: "direct-eu" }, data: { enabled: false } });
      const morOffer = await readCheckoutOffer(db(), viaMor.context, request());
      const morOpened = await openFor(viaMor.context, request());
      await db().billingRoute.update({ where: { code: "direct-eu" }, data: { enabled: true } });
      const directOpened = await openFor(direct.context, request());

      expect(directOffer).toMatchObject({ available: true, settlementModel: "DIRECT_PSP", taxRemittedBy: "SELLER" });
      expect(morOffer).toMatchObject({ available: true, settlementModel: "MERCHANT_OF_RECORD", taxRemittedBy: "PROVIDER" });
      // Different seller, different public offer document, same price.
      expect(morOpened.seller.legalName).toBe("Reseller Global Inc");
      expect(morOpened.base).toEqual(money(4_900, "EUR"));
      expect(directOpened.base).toEqual(money(4_900, "EUR"));

      for (const [provider, opened, workspaceId] of [
        ["test-psp", directOpened, direct.workspaceId],
        ["test-mor", morOpened, viaMor.workspaceId],
      ] as const) {
        const result = await recordVerifiedBillingEvent(
          db(),
          verified(provider, {
            routeCode: provider === "test-psp" ? "direct-eu" : "mor-global",
            providerEventId: `settled-${workspaceId}`,
            kind: "PAYMENT_SETTLED",
            occurredAt: NOW,
            checkoutContractId: opened.checkoutContractId,
            settled: money(4_900, "EUR"),
            providerReference: `sub_${workspaceId}`,
          }),
          NOW,
        );
        expect(result, provider).toMatchObject({ outcome: "APPLIED", effect: "ACTIVATE" });

        // The point of the criterion: the entitlement layer cannot tell the two apart.
        const entitlement = await readEntitlement(db(), workspaceId, NOW);
        expect(entitlement, provider).toMatchObject({ state: "ACTIVE", planCode: "routing-growth", paidWorkAllowed: true, subscribed: true });
        expect(entitlement.features.AI_DRAFTS, provider).toBe(true);
        const arrangement = await readArrangement(db(), workspaceId);
        expect(arrangement, provider).toMatchObject({ kind: "RECURRING", state: "ACTIVE", amount: money(4_900, "EUR") });
      }
    });
  });

  describe("only a verified event activates", () => {
    it("refuses an event this process did not mint, however well shaped", async () => {
      // The success-page handler, written in good faith: it has the workspace, it has the contract, and
      // all it is missing is authority nobody noticed it did not have.
      const { context, workspaceId } = await freshWorkspace();
      const opened = await openFor(context, request());
      const forged = {
        routeCode: "direct-eu",
        providerEventId: "from-a-redirect",
        kind: "PAYMENT_SETTLED",
        occurredAt: NOW,
        checkoutContractId: opened.checkoutContractId,
        settled: money(4_900, "EUR"),
        activationSource: "VERIFIED_EVENT",
      } as unknown as VerifiedBillingEvent;

      await expect(recordVerifiedBillingEvent(db(), forged, NOW)).rejects.toThrow(DbInputError);
      await expect(recordVerifiedBillingEvent(db(), forged, NOW)).rejects.toThrow(/a redirect does not/u);
      expect(await db().billingEvent.count({ where: { providerEventId: "from-a-redirect" } })).toBe(0);
      expect(await readArrangement(db(), workspaceId)).toMatchObject({ state: "PENDING" });
    });

    it("mints nothing from an unsigned delivery or an unknown provider", () => {
      deliveries.set("unsigned", { routeCode: "direct-eu", providerEventId: "unsigned", kind: "PAYMENT_SETTLED", occurredAt: NOW });

      expect(verifyProviderDelivery({ provider: "test-psp", body: "unsigned", headers: {}, receivedAt: NOW })).toBeNull();
      expect(verifyProviderDelivery({ provider: "test-psp", body: "unsigned", headers: { "x-signature": "bad" }, receivedAt: NOW })).toBeNull();
      expect(verifyProviderDelivery({ provider: "nobody", body: "unsigned", headers: { "x-signature": "good" }, receivedAt: NOW })).toBeNull();
      // Signed, and then mutation is refused: a holder of a minted event cannot edit the amount in it.
      const minted = verifyProviderDelivery({ provider: "test-psp", body: "unsigned", headers: { "x-signature": "good" }, receivedAt: NOW });
      expect(minted).not.toBeNull();
      expect(Object.isFrozen(minted)).toBe(true);
    });

    it("mints from an authoritative reconciliation, which is the other way a payment becomes a fact", async () => {
      const { context, workspaceId } = await freshWorkspace();
      const opened = await openFor(context, request({ arrangement: "PREPAID_TERM", quote: usdtQuote }));
      deliveries.set("reconcile:charge_1", {
        routeCode: "crypto-usdt",
        providerEventId: "reconciled-1",
        kind: "PAYMENT_SETTLED",
        occurredAt: new Date("2026-10-07T12:05:00.000Z"),
        checkoutContractId: opened.checkoutContractId,
        settled: money(5_120_000, "USDT"),
        settledAt: new Date("2026-10-07T12:05:00.000Z"),
      });

      const event = await reconcileProviderState("test-crypto", { routeCode: "crypto-usdt", providerReference: "charge_1" });
      expect(event?.activationSource).toBe("RECONCILIATION");
      const result = await recordVerifiedBillingEvent(db(), event as VerifiedBillingEvent, new Date("2026-10-07T12:06:00.000Z"));

      expect(result).toMatchObject({ outcome: "APPLIED", effect: "ACTIVATE" });
      const row = await db().billingEvent.findFirstOrThrow({ where: { providerEventId: "reconciled-1" }, select: { activationSource: true } });
      expect(row.activationSource).toBe("RECONCILIATION");
      expect(await readEntitlement(db(), workspaceId, NOW)).toMatchObject({ state: "ACTIVE" });
    });

    it("refuses to reconcile through an adapter that has no authoritative read", async () => {
      expect(await reconcileProviderState("test-psp", { routeCode: "direct-eu", providerReference: "x" })).toBeNull();
    });
  });

  describe("recurring and prepaid terms", () => {
    it("gives a recurring arrangement the interval's own period end and extends it on renewal", async () => {
      const { context, workspaceId } = await freshWorkspace();
      const opened = await openFor(context, request());

      await recordVerifiedBillingEvent(
        db(),
        verified("test-psp", {
          routeCode: "direct-eu",
          providerEventId: `recurring-settled-${workspaceId}`,
          kind: "PAYMENT_SETTLED",
          occurredAt: NOW,
          checkoutContractId: opened.checkoutContractId,
          settled: money(4_900, "EUR"),
        }),
        NOW,
      );
      const afterFirst = await readArrangement(db(), workspaceId);
      expect(afterFirst?.currentPeriodEnd?.toISOString()).toBe(periodEndFor("MONTH", NOW).toISOString());

      const renewal = await recordVerifiedBillingEvent(
        db(),
        verified("test-psp", {
          routeCode: "direct-eu",
          providerEventId: `recurring-renewed-${workspaceId}`,
          kind: "SUBSCRIPTION_RENEWED",
          occurredAt: NOW,
          arrangementId: opened.arrangementId,
        }),
        NOW,
      );

      expect(renewal).toMatchObject({ outcome: "APPLIED", effect: "EXTEND" });
      const extended = await readArrangement(db(), workspaceId);
      // Measured from the end of the term already bought, not from now: a renewal paid early does not
      // shorten the period the customer paid for.
      expect(extended?.currentPeriodEnd?.toISOString()).toBe(periodEndFor("MONTH", periodEndFor("MONTH", NOW)).toISOString());
      expect((await readEntitlement(db(), workspaceId, NOW)).periodEndsAt?.toISOString()).toBe(extended?.currentPeriodEnd?.toISOString());
    });

    it("requires a stated end for an active prepaid term, and assumes no renewal", async () => {
      const { context, workspaceId } = await freshWorkspace();
      const opened = await openFor(context, request({ arrangement: "PREPAID_TERM", quote: usdtQuote }));

      await recordVerifiedBillingEvent(
        db(),
        verified("test-crypto", {
          routeCode: "crypto-usdt",
          providerEventId: `prepaid-settled-${workspaceId}`,
          kind: "PAYMENT_SETTLED",
          occurredAt: new Date("2026-10-07T12:05:00.000Z"),
          checkoutContractId: opened.checkoutContractId,
          settled: money(5_120_000, "USDT"),
          settledAt: new Date("2026-10-07T12:05:00.000Z"),
        }),
        new Date("2026-10-07T12:06:00.000Z"),
      );

      const arrangement = await readArrangement(db(), workspaceId);
      expect(arrangement).toMatchObject({ kind: "PREPAID_TERM", state: "ACTIVE" });
      expect(arrangement?.currentPeriodEnd).toBeInstanceOf(Date);
      // A prepaid term without an end is a renewal nobody agreed to, and the CHECK says so too.
      await expect(
        db().$executeRawUnsafe(`UPDATE "billing_arrangements" SET "current_period_end" = NULL WHERE "id" = '${opened.arrangementId}'`),
      ).rejects.toThrow(/billing_arrangements_clock_check/u);
    });

    it("does nothing with a renewal that arrives before the first settlement", async () => {
      // Reordering, which every provider does eventually. Extending a path that is not paying for
      // anything would grant a term nobody bought.
      const { context, workspaceId } = await freshWorkspace();
      const opened = await openFor(context, request());

      const result = await recordVerifiedBillingEvent(
        db(),
        verified("test-psp", {
          routeCode: "direct-eu",
          providerEventId: `early-renewal-${workspaceId}`,
          kind: "SUBSCRIPTION_RENEWED",
          occurredAt: NOW,
          arrangementId: opened.arrangementId,
        }),
        NOW,
      );

      expect(result).toMatchObject({ outcome: "APPLIED", effect: "NONE" });
      expect(await readArrangement(db(), workspaceId)).toMatchObject({ state: "PENDING" });
      expect((await readEntitlement(db(), workspaceId, NOW)).subscribed).toBe(false);
    });
  });

  describe("a time-bounded quote", () => {
    const quote = usdtQuote;

    it("does not activate on an underpayment, and leaves the money's owner a decision", async () => {
      const { context, workspaceId } = await freshWorkspace();
      const opened = await openFor(context, request({ arrangement: "PREPAID_TERM", quote }));

      const result = await recordVerifiedBillingEvent(
        db(),
        verified("test-crypto", {
          routeCode: "crypto-usdt",
          providerEventId: `under-${workspaceId}`,
          kind: "PAYMENT_SETTLED",
          occurredAt: new Date("2026-10-07T12:05:00.000Z"),
          checkoutContractId: opened.checkoutContractId,
          settled: money(5_119_999, "USDT"),
          settledAt: new Date("2026-10-07T12:05:00.000Z"),
        }),
        new Date("2026-10-07T12:06:00.000Z"),
      );

      expect(result).toMatchObject({ outcome: "APPLIED", effect: "NONE", quote: "UNDERPAID" });
      expect(await readEntitlement(db(), workspaceId, NOW)).toMatchObject({ paidWorkAllowed: false, subscribed: false });
      // Still open: the money arrived, and a person decides between a top-up and a refund.
      expect(await db().checkoutContract.findUniqueOrThrow({ where: { id: opened.checkoutContractId }, select: { state: true } })).toEqual({ state: "OPEN" });
    });

    it("does not activate on a full payment that arrived after the window closed", async () => {
      // The case that looks like success. The rate it was priced at is no longer the rate.
      const { context, workspaceId } = await freshWorkspace();
      const opened = await openFor(context, request({ arrangement: "PREPAID_TERM", quote }));

      const result = await recordVerifiedBillingEvent(
        db(),
        verified("test-crypto", {
          routeCode: "crypto-usdt",
          providerEventId: `late-${workspaceId}`,
          kind: "PAYMENT_SETTLED",
          occurredAt: new Date("2026-10-07T12:20:00.000Z"),
          checkoutContractId: opened.checkoutContractId,
          settled: money(5_120_000, "USDT"),
          settledAt: new Date("2026-10-07T12:20:00.000Z"),
        }),
        new Date("2026-10-07T12:21:00.000Z"),
      );

      expect(result).toMatchObject({ outcome: "APPLIED", effect: "NONE", quote: "AMBIGUOUS" });
      expect(await readEntitlement(db(), workspaceId, NOW)).toMatchObject({ paidWorkAllowed: false });
    });

    it("closes the checkout and releases the charge path when the window ran out with nothing settled", async () => {
      const { context, workspaceId } = await freshWorkspace();
      const opened = await openFor(context, request({ arrangement: "PREPAID_TERM", quote }));

      const result = await recordVerifiedBillingEvent(
        db(),
        verified("test-crypto", {
          routeCode: "crypto-usdt",
          providerEventId: `expired-${workspaceId}`,
          kind: "PAYMENT_SETTLED",
          occurredAt: new Date("2026-10-07T12:30:00.000Z"),
          checkoutContractId: opened.checkoutContractId,
        }),
        new Date("2026-10-07T12:30:00.000Z"),
      );

      expect(result).toMatchObject({ effect: "NONE", quote: "EXPIRED" });
      expect(await db().checkoutContract.findUniqueOrThrow({ where: { id: opened.checkoutContractId }, select: { state: true } })).toEqual({ state: "EXPIRED" });
      expect(await readArrangement(db(), workspaceId)).toBeNull();
    });

    it("activates on the full amount inside the window, and keeps the catalogue price as the base", async () => {
      const { context, workspaceId } = await freshWorkspace();
      const opened = await openFor(context, request({ arrangement: "PREPAID_TERM", quote }));

      const result = await recordVerifiedBillingEvent(
        db(),
        verified("test-crypto", {
          routeCode: "crypto-usdt",
          providerEventId: `settled-quote-${workspaceId}`,
          kind: "PAYMENT_SETTLED",
          occurredAt: new Date("2026-10-07T12:10:00.000Z"),
          checkoutContractId: opened.checkoutContractId,
          settled: money(5_120_000, "USDT"),
          settledAt: new Date("2026-10-07T12:10:00.000Z"),
        }),
        new Date("2026-10-07T12:11:00.000Z"),
      );

      expect(result).toMatchObject({ outcome: "APPLIED", effect: "ACTIVATE", quote: "SETTLED" });
      // The quote did not rewrite what the plan costs: the base price is the catalogue's USDT price and
      // the charge is what this quote asked for.
      const contract = await db().checkoutContract.findUniqueOrThrow({
        where: { id: opened.checkoutContractId },
        select: { baseAmountMinor: true, baseCurrency: true, chargeAmountMinor: true, chargeCurrency: true },
      });
      expect(contract).toEqual({ baseAmountMinor: 4_900, baseCurrency: "EUR", chargeAmountMinor: 5_120_000, chargeCurrency: "USDT" });
      expect(await readEntitlement(db(), workspaceId, NOW)).toMatchObject({ state: "ACTIVE" });
    });
  });

  describe("duplicate and replayed provider events", () => {
    it("applies once and reports the first effect for every redelivery", async () => {
      const { context, workspaceId } = await freshWorkspace();
      const opened = await openFor(context, request());
      const event = verified("test-psp", {
        routeCode: "direct-eu",
        providerEventId: `once-${workspaceId}`,
        kind: "PAYMENT_SETTLED",
        occurredAt: NOW,
        checkoutContractId: opened.checkoutContractId,
        settled: money(4_900, "EUR"),
      });

      const first = await recordVerifiedBillingEvent(db(), event, NOW);
      const periodAfterFirst = (await readArrangement(db(), workspaceId))?.currentPeriodEnd;
      const second = await recordVerifiedBillingEvent(db(), event, new Date(NOW.getTime() + 60_000));
      const third = await recordVerifiedBillingEvent(
        db(),
        verified("test-psp", {
          routeCode: "direct-eu",
          providerEventId: `once-${workspaceId}`,
          kind: "PAYMENT_SETTLED",
          occurredAt: NOW,
          checkoutContractId: opened.checkoutContractId,
          settled: money(4_900, "EUR"),
        }),
        new Date(NOW.getTime() + 120_000),
      );

      expect(first).toMatchObject({ outcome: "APPLIED", effect: "ACTIVATE" });
      expect(second).toMatchObject({ outcome: "DUPLICATE", effect: "ACTIVATE" });
      // Freshly minted from a second delivery of the same provider event: same answer, because
      // idempotency is keyed on the provider's identifier and not on the object's identity.
      expect(third).toMatchObject({ outcome: "DUPLICATE", effect: "ACTIVATE" });
      expect(await db().billingEvent.count({ where: { providerEventId: `once-${workspaceId}` } })).toBe(1);
      expect((await readArrangement(db(), workspaceId))?.currentPeriodEnd?.toISOString()).toBe(periodAfterFirst?.toISOString());
    });

    it("keeps the same provider event identifier on two routes apart", async () => {
      // Route isolation for events: a provider's identifiers are unique within its own account, which is
      // what a route names. Scoping idempotency to the workspace would make one provider's identifier
      // suppress another's.
      const first = await freshWorkspace();
      const second = await freshWorkspace();
      const firstOpened = await openFor(first.context, request());
      await db().billingRoute.update({ where: { code: "direct-eu" }, data: { enabled: false } });
      const secondOpened = await openFor(second.context, request());
      await db().billingRoute.update({ where: { code: "direct-eu" }, data: { enabled: true } });

      const shared = "evt_shared_identifier";
      const a = await recordVerifiedBillingEvent(
        db(),
        verified("test-psp", {
          routeCode: "direct-eu",
          providerEventId: shared,
          kind: "PAYMENT_SETTLED",
          occurredAt: NOW,
          checkoutContractId: firstOpened.checkoutContractId,
          settled: money(4_900, "EUR"),
        }),
        NOW,
      );
      const b = await recordVerifiedBillingEvent(
        db(),
        verified("test-mor", {
          routeCode: "mor-global",
          providerEventId: shared,
          kind: "PAYMENT_SETTLED",
          occurredAt: NOW,
          checkoutContractId: secondOpened.checkoutContractId,
          settled: money(4_900, "EUR"),
        }),
        NOW,
      );

      expect(a).toMatchObject({ outcome: "APPLIED", effect: "ACTIVATE" });
      expect(b).toMatchObject({ outcome: "APPLIED", effect: "ACTIVATE" });
      expect(await db().billingEvent.count({ where: { providerEventId: shared } })).toBe(2);
    });

    it("will not settle a contract opened on another route", async () => {
      const { context } = await freshWorkspace();
      const opened = await openFor(context, request());

      const result = await recordVerifiedBillingEvent(
        db(),
        verified("test-mor", {
          routeCode: "mor-global",
          providerEventId: "cross-route",
          kind: "PAYMENT_SETTLED",
          occurredAt: NOW,
          checkoutContractId: opened.checkoutContractId,
          settled: money(4_900, "EUR"),
        }),
        NOW,
      );

      // The contract is not this provider's to settle, so there is nothing the event can be attributed to.
      expect(result).toMatchObject({ outcome: "UNATTRIBUTED", effect: "NONE" });
      expect(await db().checkoutContract.findUniqueOrThrow({ where: { id: opened.checkoutContractId }, select: { state: true } })).toEqual({ state: "OPEN" });
    });

    it("records an event it cannot attribute, so a redelivery is not processed afresh", async () => {
      const result = await recordVerifiedBillingEvent(
        db(),
        verified("test-psp", { routeCode: "direct-eu", providerEventId: "about-nothing", kind: "PAYMENT_FAILED", occurredAt: NOW }),
        NOW,
      );
      const again = await recordVerifiedBillingEvent(
        db(),
        verified("test-psp", { routeCode: "direct-eu", providerEventId: "about-nothing", kind: "PAYMENT_FAILED", occurredAt: NOW }),
        NOW,
      );

      expect(result.outcome).toBe("UNATTRIBUTED");
      expect(again.outcome).toBe("DUPLICATE");
    });

    it("reports an unknown route rather than inventing one", async () => {
      const result = await recordVerifiedBillingEvent(
        db(),
        verified("test-psp", { routeCode: "route-that-was-deleted", providerEventId: "orphan", kind: "PAYMENT_SETTLED", occurredAt: NOW }),
        NOW,
      );

      expect(result).toEqual({ outcome: "UNKNOWN_ROUTE", effect: "NONE" });
    });
  });

  describe("switching provider", () => {
    it("never leaves two live charge paths, and keeps the old references for reconciliation", async () => {
      const { context, workspaceId } = await freshWorkspace();
      const first = await openFor(context, request());
      await recordVerifiedBillingEvent(
        db(),
        verified("test-psp", {
          routeCode: "direct-eu",
          providerEventId: `migrate-settled-${workspaceId}`,
          kind: "PAYMENT_SETTLED",
          occurredAt: NOW,
          checkoutContractId: first.checkoutContractId,
          settled: money(4_900, "EUR"),
          providerReference: "sub_old_provider",
        }),
        NOW,
      );

      // A second checkout that has not said it is migrating is refused. This is "never create a second
      // active charge path silently", and the default is the refusal.
      const refused = await openCheckoutContract(db(), context, { ...request(), acceptedDocumentIds: await acceptedIds(context, request()) });

      expect(refused).toMatchObject({ available: false, reason: "ARRANGEMENT_EXISTS" });

      await db().billingRoute.update({ where: { code: "direct-eu" }, data: { enabled: false } });
      const migrated = await openFor(context, request({ supersedeCurrent: true }));
      await db().billingRoute.update({ where: { code: "direct-eu" }, data: { enabled: true } });

      expect(migrated.supersededArrangementId).toBe(first.arrangementId);
      expect(migrated.seller.legalName).toBe("Reseller Global Inc");
      const live = await db().billingArrangement.findMany({ where: { workspaceId, state: { in: ["PENDING", "ACTIVE"] } }, select: { id: true } });
      expect(live).toEqual([{ id: migrated.arrangementId }]);
      const old = await db().billingArrangement.findUniqueOrThrow({
        where: { id: first.arrangementId },
        select: { state: true, endedAt: true, supersededById: true, providerReference: true },
      });
      expect(old).toMatchObject({ state: "SUPERSEDED", supersededById: migrated.arrangementId, providerReference: "sub_old_provider" });
      expect(old.endedAt).toBeInstanceOf(Date);
    });

    it("will not resurrect the superseded path when the old provider settles afterwards", async () => {
      const { context, workspaceId } = await freshWorkspace();
      const first = await openFor(context, request());
      await db().billingRoute.update({ where: { code: "direct-eu" }, data: { enabled: false } });
      const second = await openFor(context, request({ supersedeCurrent: true }));
      await db().billingRoute.update({ where: { code: "direct-eu" }, data: { enabled: true } });

      const late = await recordVerifiedBillingEvent(
        db(),
        verified("test-psp", {
          routeCode: "direct-eu",
          providerEventId: `late-old-provider-${workspaceId}`,
          kind: "PAYMENT_SETTLED",
          occurredAt: NOW,
          checkoutContractId: first.checkoutContractId,
          settled: money(4_900, "EUR"),
        }),
        NOW,
      );

      expect(late).toMatchObject({ outcome: "APPLIED", effect: "NONE" });
      const live = await db().billingArrangement.findMany({ where: { workspaceId, state: { in: ["PENDING", "ACTIVE"] } }, select: { id: true } });
      expect(live).toEqual([{ id: second.arrangementId }]);
      expect((await readEntitlement(db(), workspaceId, NOW)).subscribed).toBe(false);
    });

    it("refuses a second live arrangement written by raw SQL, and says which states count as live", async () => {
      // The index is what makes one-live structural. Asserted per state, because the predicate is spelled
      // as "not ended and not superseded" and a state added later would inherit that classification.
      const { context, workspaceId } = await freshWorkspace();
      const opened = await openFor(context, request());
      const route = await db().billingRoute.findUniqueOrThrow({ where: { code: "mor-global" }, select: { id: true } });

      const insert = (id: string, state: string): Promise<number> =>
        db().$executeRawUnsafe(
          `INSERT INTO "billing_arrangements" ("id","workspace_id","billing_route_id","plan_version_id","kind","state","interval","amount_minor","currency","started_at","current_period_end","ended_at","superseded_by_id","updated_at")
           VALUES ('${id}','${workspaceId}','${route.id}','${planVersionId}','RECURRING','${state}','MONTH',4900,'EUR',
                   ${state === "PENDING" ? "NULL" : "NOW()"},
                   ${state === "PENDING" ? "NULL" : "NOW() + INTERVAL '30 days'"},
                   ${state === "ENDED" || state === "SUPERSEDED" ? "NOW()" : "NULL"},
                   ${state === "SUPERSEDED" ? `'${opened.arrangementId}'` : "NULL"}, NOW())`,
        );

      await expect(insert("raw-pending", "PENDING")).rejects.toThrow(/billing_arrangements_one_live_key/u);
      await expect(insert("raw-active", "ACTIVE")).rejects.toThrow(/billing_arrangements_one_live_key/u);
      // Not live, so a workspace may have any number of them: that is the history.
      await expect(insert("raw-ended", "ENDED")).resolves.toBe(1);
      await expect(insert("raw-superseded", "SUPERSEDED")).resolves.toBe(1);
    });
  });

  describe("reversals", () => {
    it("ends the charge path and stops paid work without deleting anything", async () => {
      const { context, workspaceId } = await freshWorkspace();
      const opened = await openFor(context, request());
      await recordVerifiedBillingEvent(
        db(),
        verified("test-psp", {
          routeCode: "direct-eu",
          providerEventId: `refund-settled-${workspaceId}`,
          kind: "PAYMENT_SETTLED",
          occurredAt: NOW,
          checkoutContractId: opened.checkoutContractId,
          settled: money(4_900, "EUR"),
        }),
        NOW,
      );

      const refunded = await recordVerifiedBillingEvent(
        db(),
        verified("test-psp", {
          routeCode: "direct-eu",
          providerEventId: `refunded-${workspaceId}`,
          kind: "REFUNDED",
          occurredAt: NOW,
          arrangementId: opened.arrangementId,
          settled: money(4_900, "EUR"),
        }),
        NOW,
      );

      expect(refunded).toMatchObject({ outcome: "APPLIED", effect: "END" });
      expect(await readArrangement(db(), workspaceId)).toBeNull();
      const entitlement = await readEntitlement(db(), workspaceId, NOW);
      expect(entitlement).toMatchObject({ state: "INACTIVE", paidWorkAllowed: false });
      // The contract, the acceptance and the events all survive. Nothing is deleted to settle a dispute.
      expect(await db().checkoutContract.count({ where: { workspaceId } })).toBe(1);
      expect(await db().legalAcceptance.count({ where: { workspaceId } })).toBe(2);
    });

    it("cancels at the end of the term already paid for", async () => {
      const { context, workspaceId } = await freshWorkspace();
      const opened = await openFor(context, request());
      await recordVerifiedBillingEvent(
        db(),
        verified("test-psp", {
          routeCode: "direct-eu",
          providerEventId: `cancel-settled-${workspaceId}`,
          kind: "PAYMENT_SETTLED",
          occurredAt: NOW,
          checkoutContractId: opened.checkoutContractId,
          settled: money(4_900, "EUR"),
        }),
        NOW,
      );

      const canceled = await recordVerifiedBillingEvent(
        db(),
        verified("test-psp", {
          routeCode: "direct-eu",
          providerEventId: `canceled-${workspaceId}`,
          kind: "SUBSCRIPTION_CANCELED",
          occurredAt: NOW,
          arrangementId: opened.arrangementId,
        }),
        NOW,
      );

      expect(canceled).toMatchObject({ effect: "END" });
      const entitlement = await readEntitlement(db(), workspaceId, NOW);
      expect(entitlement.state).toBe("CANCELED_PENDING_END");
      // Still paying for what it bought until the term ends; that is the accepted default.
      expect(entitlement.paidWorkAllowed).toBe(true);
    });

    it("suspends into grace on a failed payment rather than ending anything", async () => {
      const { context, workspaceId } = await freshWorkspace();
      const opened = await openFor(context, request());
      await recordVerifiedBillingEvent(
        db(),
        verified("test-psp", {
          routeCode: "direct-eu",
          providerEventId: `grace-settled-${workspaceId}`,
          kind: "PAYMENT_SETTLED",
          occurredAt: NOW,
          checkoutContractId: opened.checkoutContractId,
          settled: money(4_900, "EUR"),
        }),
        NOW,
      );

      const failed = await recordVerifiedBillingEvent(
        db(),
        verified("test-psp", {
          routeCode: "direct-eu",
          providerEventId: `failed-${workspaceId}`,
          kind: "PAYMENT_FAILED",
          occurredAt: NOW,
          arrangementId: opened.arrangementId,
        }),
        NOW,
      );

      expect(failed).toMatchObject({ effect: "SUSPEND" });
      expect(await db().workspaceSubscription.findUniqueOrThrow({ where: { workspaceId }, select: { state: true } })).toEqual({ state: "GRACE" });
      // The charge path is still there: a card that failed is retried, not migrated.
      expect(await readArrangement(db(), workspaceId)).toMatchObject({ state: "ACTIVE" });
    });
  });

  describe("the acceptance snapshot", () => {
    it("offers the seller's own public offer and nothing that is not yet in force", async () => {
      const { context } = await freshWorkspace();
      const offer = await readCheckoutOffer(db(), context, request());

      expect(offer.available).toBe(true);
      if (offer.available) {
        expect(offer.documents.map((document) => document.kind).sort()).toEqual(["PUBLIC_OFFER", "TERMS_OF_SERVICE"]);
        expect(offer.documents.find((document) => document.kind === "PUBLIC_OFFER")?.contentRef).toBe("https://legal.example.test/offer/ro/en/1");
        // Effective next year. Published, not offered.
        expect(offer.documents.some((document) => document.kind === "PRIVACY_POLICY")).toBe(false);
      }
    });

    it("refuses a checkout that is missing a required acceptance, and names which one", async () => {
      const { context, workspaceId } = await freshWorkspace();
      const documents = await acceptedIds(context, request());

      const refused = await openCheckoutContract(db(), context, { ...request(), acceptedDocumentIds: documents.slice(0, 1) });

      expect(refused).toMatchObject({ available: false, reason: "TERMS_NOT_ACCEPTED" });
      if (!refused.available) {
        expect(refused.detail.length).toBe(1);
      }
      expect(await db().checkoutContract.count({ where: { workspaceId } })).toBe(0);
    });

    it("refuses an acceptance of another seller's document", async () => {
      const { context } = await freshWorkspace();
      const theirs = await db().legalDocument.findFirstOrThrow({
        where: { contentRef: "https://legal.example.test/offer/mor/en/1" },
        select: { id: true },
      });
      const mine = await acceptedIds(context, request());

      const refused = await openCheckoutContract(db(), context, {
        ...request(),
        acceptedDocumentIds: [...mine.filter((id) => id !== theirs.id), theirs.id],
      });

      expect(refused).toMatchObject({ available: false, reason: "DOCUMENT_NOT_APPLICABLE" });
    });

    it("will not let a checkout commit without its acceptances, whoever writes it", async () => {
      // Raw SQL, because the rule has to hold for a support script as well as for the store. The deferred
      // constraint trigger fires at commit, which is the only moment the question has a stable answer.
      const { workspaceId, ownerUserId } = await freshWorkspace();
      const route = await db().billingRoute.findUniqueOrThrow({ where: { code: "direct-eu" }, select: { id: true, sellerProfileId: true } });

      await expect(
        db().$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `INSERT INTO "checkout_contracts" ("id","workspace_id","actor_user_id","plan_version_id","billing_route_id","seller_profile_id","seller_legal_name","seller_jurisdiction","arrangement_kind","interval","base_amount_minor","base_currency","charge_amount_minor","charge_currency","opened_at","updated_at")
             VALUES ('raw-no-acceptance','${workspaceId}','${ownerUserId}','${planVersionId}','${route.id}','${route.sellerProfileId}','Example SRL','RO','RECURRING','MONTH',4900,'EUR',4900,'EUR',NOW(),NOW())`,
          );
        }),
      ).rejects.toThrow(/has no accepted PUBLIC_OFFER, TERMS_OF_SERVICE/u);

      expect(await db().checkoutContract.count({ where: { id: "raw-no-acceptance" } })).toBe(0);
    });

    it("cannot be edited or removed afterwards, and the seller it names cannot be rewritten", async () => {
      const { context } = await freshWorkspace();
      const opened = await openFor(context, request());
      const acceptance = await db().legalAcceptance.findFirstOrThrow({ where: { checkoutContractId: opened.checkoutContractId }, select: { id: true } });

      await expect(
        db().$executeRawUnsafe(`UPDATE "checkout_contracts" SET "base_amount_minor" = 1 WHERE "id" = '${opened.checkoutContractId}'`),
      ).rejects.toThrow(/checkout_contracts are immutable/u);
      await expect(
        db().$executeRawUnsafe(`UPDATE "checkout_contracts" SET "seller_legal_name" = 'Somebody Else' WHERE "id" = '${opened.checkoutContractId}'`),
      ).rejects.toThrow(/checkout_contracts are immutable/u);
      await expect(db().$executeRawUnsafe(`DELETE FROM "checkout_contracts" WHERE "id" = '${opened.checkoutContractId}'`)).rejects.toThrow(
        /never deleted/u,
      );
      await expect(db().$executeRawUnsafe(`UPDATE "legal_acceptances" SET "accepted_at" = NOW() WHERE "id" = '${acceptance.id}'`)).rejects.toThrow(
        /append-only/u,
      );
      await expect(db().$executeRawUnsafe(`DELETE FROM "legal_acceptances" WHERE "id" = '${acceptance.id}'`)).rejects.toThrow(/append-only/u);

      // The selling entity changes its registered name. What a customer was told last March does not.
      await upsertSellerProfile(db(), {
        code: "seller-ro",
        legalName: "Example SRL (renamed)",
        displayName: "Example",
        jurisdiction: "RO",
        supportEmail: "billing@example.test",
      });
      try {
        expect(
          await db().checkoutContract.findUniqueOrThrow({ where: { id: opened.checkoutContractId }, select: { sellerLegalName: true } }),
        ).toEqual({ sellerLegalName: "Example SRL" });
      } finally {
        await upsertSellerProfile(db(), {
          code: "seller-ro",
          legalName: "Example SRL",
          displayName: "Example",
          jurisdiction: "RO",
          supportEmail: "billing@example.test",
          legalConfigRef: "config/ro",
        });
      }
    });

    it("refuses a legal document version that is immutable once published", async () => {
      const published = await db().legalDocument.findFirstOrThrow({ where: { contentRef: "https://legal.example.test/terms/en/1" }, select: { id: true } });

      await expect(db().$executeRawUnsafe(`UPDATE "legal_documents" SET "content_ref" = 'terms/en/1-edited' WHERE "id" = '${published.id}'`)).rejects.toThrow(
        /legal_documents are immutable/u,
      );
    });

    it("assigns the next version per kind and locale", async () => {
      const second = await publishLegalDocument(db(), {
        kind: "TERMS_OF_SERVICE",
        locale: "en",
        contentRef: "https://legal.example.test/terms/en/2",
        effectiveFrom: new Date("2026-02-01T00:00:00.000Z"),
      });
      const other = await publishLegalDocument(db(), {
        kind: "TERMS_OF_SERVICE",
        locale: "ru",
        contentRef: "https://legal.example.test/terms/ru/1",
        effectiveFrom: new Date("2026-02-01T00:00:00.000Z"),
      });

      expect(second.version).toBe(2);
      expect(other.version).toBe(1);
      // And the newer English version is what a checkout is offered against from now on.
      const { context } = await freshWorkspace();
      const offer = await readCheckoutOffer(db(), context, request());
      if (offer.available) {
        expect(offer.documents.find((document) => document.kind === "TERMS_OF_SERVICE")).toMatchObject({ version: 2, contentRef: "https://legal.example.test/terms/en/2" });
      }
    });
  });

  describe("the provider's own checkout session", () => {
    it("is recorded once and never replaced", async () => {
      const { context } = await freshWorkspace();
      const opened = await openFor(context, request());

      await attachProviderCheckoutReference(db(), opened.checkoutContractId, "cs_first");
      // Idempotent for the same reference: a retried attach is the same statement twice.
      await attachProviderCheckoutReference(db(), opened.checkoutContractId, "cs_first");
      await expect(attachProviderCheckoutReference(db(), opened.checkoutContractId, "cs_second")).rejects.toThrow(/already has a provider reference/u);
      await expect(
        db().$executeRawUnsafe(`UPDATE "checkout_contracts" SET "provider_checkout_ref" = 'cs_raw' WHERE "id" = '${opened.checkoutContractId}'`),
      ).rejects.toThrow(/second session/u);
    });
  });

  describe("an abandoned checkout", () => {
    it("gives the charge path back, so one unfinished attempt does not block every later one", async () => {
      const { context, workspaceId } = await freshWorkspace();
      await openFor(context, request({ arrangement: "PREPAID_TERM", quote: usdtQuote }));

      const released = await expireStaleCheckouts(db(), new Date("2026-10-07T12:16:00.000Z"));

      expect(released).toBeGreaterThanOrEqual(1);
      expect(await readArrangement(db(), workspaceId)).toBeNull();
      // And the workspace can buy again.
      const second = await openFor(context, request());
      expect(second.seller.legalName).toBe("Example SRL");
    });

    it("distinguishes a quote that ran out from a checkout nobody came back to", async () => {
      const { context, workspaceId } = await freshWorkspace();
      await openFor(context, request({ at: new Date("2026-10-05T12:00:00.000Z") }));

      await expireStaleCheckouts(db(), new Date("2026-10-07T12:00:00.000Z"));

      const contract = await db().checkoutContract.findFirstOrThrow({ where: { workspaceId }, select: { state: true } });
      expect(contract.state).toBe("ABANDONED");
    });

    it("leaves a checkout that is still inside its window alone", async () => {
      const { context, workspaceId } = await freshWorkspace();
      await openFor(context, request({ at: new Date("2026-10-07T11:50:00.000Z") }));

      expect(await expireStaleCheckouts(db(), new Date("2026-10-07T12:00:00.000Z"))).toBe(0);
      expect(await readArrangement(db(), workspaceId)).toMatchObject({ state: "PENDING" });
    });
  });

  describe("the audit trail", () => {
    it("records the checkout in the product's vocabulary, with no provider identifier in it", async () => {
      const { context } = await freshWorkspace();
      const opened = await openFor(context, request());

      const page = await searchAuditEvents(db(), context, { kinds: ["CHECKOUT_OPENED"] });
      const row = page.rows.find((event) => event.subjectId === opened.checkoutContractId);

      expect(row?.summary).toContain("Example SRL");
      const detail = JSON.stringify(row?.detail ?? {});
      expect(detail).toContain("direct-eu");
      expect(detail).toContain("TERMS_OF_SERVICE v");
      // The route's operator-facing code is fine; the provider's name and its account are not.
      expect(detail).not.toContain("test-psp");
      expect(detail).not.toContain("acct_direct");
    });

    it("records what a verified event did, and stores no payload, header or signature", async () => {
      const { context, workspaceId } = await freshWorkspace();
      const opened = await openFor(context, request());
      await recordVerifiedBillingEvent(
        db(),
        verified("test-psp", {
          routeCode: "direct-eu",
          providerEventId: `audited-${workspaceId}`,
          kind: "PAYMENT_SETTLED",
          occurredAt: NOW,
          checkoutContractId: opened.checkoutContractId,
          settled: money(4_900, "EUR"),
        }),
        NOW,
      );

      const row = await db().billingEvent.findFirstOrThrow({ where: { providerEventId: `audited-${workspaceId}` }, select: { detail: true, effect: true, activationSource: true } });
      expect(row).toMatchObject({ effect: "ACTIVATE", activationSource: "VERIFIED_EVENT" });
      expect(JSON.stringify(row.detail)).not.toMatch(/signature|x-signature|header/iu);

      const page = await searchAuditEvents(db(), context, { kinds: ["BILLING_ARRANGEMENT_CHANGED"] });
      expect(page.rows.some((event) => event.actorKind === "SYSTEM")).toBe(true);
    });

    it("is append-only for events, because an original is what a dispute is argued from", async () => {
      const row = await db().billingEvent.findFirstOrThrow({ select: { id: true } });

      await expect(db().$executeRawUnsafe(`UPDATE "billing_events" SET "effect" = 'ACTIVATE' WHERE "id" = '${row.id}'`)).rejects.toThrow(/append-only/u);
      await expect(db().$executeRawUnsafe(`DELETE FROM "billing_events" WHERE "id" = '${row.id}'`)).rejects.toThrow(/append-only/u);
    });
  });

  describe("the locale somebody reads the terms in", () => {
    /**
     * Its own seller, its own route, its own currency and its own document kind.
     *
     * The suite publishes English and Russian terms elsewhere, so a locale test that leaned on the shared
     * fixtures would pass or fail according to which other test had run — which is a test that passes for
     * the wrong reason. `REFUND_POLICY` is used here and nowhere else precisely so its translations are
     * this block's to control.
     */
    let localeSellerId: string;

    beforeAll(async () => {
      await upsertSellerProfile(db(), {
        code: "seller-locale",
        legalName: "Locale SRL",
        displayName: "Locale",
        jurisdiction: "RO",
        supportEmail: "billing@locale.test",
      });
      await upsertBillingRoute(db(), {
        code: "locale-route",
        provider: "test-psp",
        sellerProfileCode: "seller-locale",
        settlementModel: "DIRECT_PSP",
        capabilities: ["RECURRING_SUBSCRIPTIONS", "VERIFIED_WEBHOOKS"],
        currencies: ["PLN"],
        intervals: ["MONTH"],
        enabled: true,
        priority: 1,
      });
      await db().planPrice.create({ data: { planVersionId, currency: "PLN", interval: "MONTH", amountCents: 21_000 } });
      await publishLegalDocument(db(), {
        kind: "REFUND_POLICY",
        locale: "en",
        contentRef: "https://legal.example.test/refund/en/1",
        sellerProfileCode: "seller-locale",
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      });
      localeSellerId = (await db().sellerProfile.findUniqueOrThrow({ where: { code: "seller-locale" }, select: { id: true } })).id;
    }, 60_000);

    const inPln = (overrides: Partial<Request> = {}) => request({ currency: "PLN", ...overrides });

    it("offers the fallback language rather than nothing, and says it is not the reader's", async () => {
      // The defect this closes. Filtering documents by an exact locale offered a Russian-reading
      // workspace *no document of that kind at all* — which is not a stricter checkout, it is one whose
      // acceptance control silently disappeared — and the database's coverage trigger then killed the
      // checkout with a raw exception instead of a sentence.
      const { context } = await freshWorkspace();
      const offer = await readCheckoutOffer(db(), context, inPln({ locale: "ru" }), NOW);

      expect(offer.available).toBe(true);
      if (offer.available) {
        expect(offer.viewerLocale).toBe("ru");
        const refund = offer.documents.find((document) => document.kind === "REFUND_POLICY");
        expect(refund).toMatchObject({ locale: "en", contentRef: "https://legal.example.test/refund/en/1", inViewerLanguage: false, requiredForCheckout: true });
      }
    });

    it("records the reader's own language on every acceptance, whatever the document was published in", async () => {
      const { context } = await freshWorkspace();
      const opened = await openFor(context, inPln({ locale: "ru" }));

      const acceptances = await db().legalAcceptance.findMany({
        where: { checkoutContractId: opened.checkoutContractId },
        select: { locale: true, legalDocument: { select: { locale: true, kind: true } } },
      });

      expect(acceptances.length).toBeGreaterThan(1);
      const refund = acceptances.find((acceptance) => acceptance.legalDocument.kind === "REFUND_POLICY");
      // Asserted as an inequality, not as two equalities that another test's publication could make
      // identical: this is the only shape in which "the reader's language, not the document's" can fail.
      expect(refund?.locale).toBe("ru");
      expect(refund?.legalDocument.locale).toBe("en");
      expect(refund?.locale).not.toBe(refund?.legalDocument.locale);
      for (const acceptance of acceptances) {
        expect(acceptance.locale, acceptance.legalDocument.kind).toBe("ru");
      }
    });

    it("prefers a translation once one exists", async () => {
      await publishLegalDocument(db(), {
        kind: "REFUND_POLICY",
        locale: "ru",
        contentRef: "https://legal.example.test/refund/ru/1",
        sellerProfileCode: "seller-locale",
        effectiveFrom: new Date("2026-02-01T00:00:00.000Z"),
      });
      const { context } = await freshWorkspace();

      const offer = await readCheckoutOffer(db(), context, inPln({ locale: "ru" }), NOW);

      expect(offer.available).toBe(true);
      if (offer.available) {
        expect(offer.documents.find((document) => document.kind === "REFUND_POLICY")).toMatchObject({
          locale: "ru",
          contentRef: "https://legal.example.test/refund/ru/1",
          inViewerLanguage: true,
        });
      }
      void localeSellerId;
    });

    it("refuses when a required document is published in no language the reader could be offered", async () => {
      // Operator misconfiguration rather than a customer's circumstance: the fallback locale is the one
      // the product publishes everything in, so a required kind missing from it is a gap somebody fills.
      await upsertSellerProfile(db(), {
        code: "seller-de-only",
        legalName: "Nur Deutsch GmbH",
        displayName: "Nur Deutsch",
        jurisdiction: "DE",
        supportEmail: "billing@nur.test",
      });
      await upsertBillingRoute(db(), {
        code: "de-only",
        provider: "test-psp",
        sellerProfileCode: "seller-de-only",
        settlementModel: "DIRECT_PSP",
        capabilities: ["RECURRING_SUBSCRIPTIONS", "VERIFIED_WEBHOOKS"],
        currencies: ["CHF"],
        intervals: ["MONTH"],
        enabled: true,
        priority: 1,
      });
      await publishLegalDocument(db(), {
        kind: "PUBLIC_OFFER",
        locale: "de",
        contentRef: "https://legal.example.test/offer/de/1",
        sellerProfileCode: "seller-de-only",
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      });
      await db().planPrice.create({ data: { planVersionId, currency: "CHF", interval: "MONTH", amountCents: 5_000 } });
      const { context } = await freshWorkspace();

      try {
        const offer = await readCheckoutOffer(db(), context, request({ currency: "CHF" }), NOW);

        expect(offer).toMatchObject({ available: false, reason: "DOCUMENT_UNAVAILABLE" });
        if (!offer.available) {
          expect(offer.detail.join(" ")).toContain("PUBLIC_OFFER");
        }
      } finally {
        await db().billingRoute.update({ where: { code: "de-only" }, data: { enabled: false } });
      }
    });
  });

  describe("the current version, and only the current version", () => {
    it("refuses a superseded version with its own reason, so the screen can say the terms changed", async () => {
      const { context } = await freshWorkspace();
      const before = await readCheckoutOffer(db(), context, request(), NOW);
      const staleIds = before.available ? before.documents.filter((document) => document.requiredForCheckout).map((document) => document.legalDocumentId) : [];

      // A new version becomes effective between the page that drew the checkboxes and the submission.
      const published = await publishLegalDocument(db(), {
        kind: "PUBLIC_OFFER",
        locale: "en",
        contentRef: "https://legal.example.test/offer/ro/en/next",
        sellerProfileCode: "seller-ro",
        effectiveFrom: new Date("2026-03-01T00:00:00.000Z"),
      });

      const refused = await openCheckoutContract(db(), context, { ...request(), acceptedDocumentIds: staleIds });

      expect(refused).toMatchObject({ available: false, reason: "DOCUMENT_SUPERSEDED" });
      if (!refused.available) {
        expect(refused.detail.join(" ")).toContain("PUBLIC_OFFER v1");
      }
      // And accepting what the page would show now succeeds.
      const opened = await openFor(context, request());
      const accepted = await db().legalAcceptance.findMany({
        where: { checkoutContractId: opened.checkoutContractId },
        select: { legalDocument: { select: { kind: true, version: true } } },
      });
      expect(accepted.find((row) => row.legalDocument.kind === "PUBLIC_OFFER")?.legalDocument.version).toBe(published.version);
    });

    it("refuses a superseded version written straight to the table, whoever writes it", async () => {
      // The store refuses it above; this is the same rule where a support script would meet it.
      const { context, workspaceId, ownerUserId } = await freshWorkspace();
      const opened = await openFor(context, request());
      const superseded = await db().legalDocument.findFirstOrThrow({ where: { contentRef: "https://legal.example.test/offer/ro/en/1" }, select: { id: true } });

      await expect(
        db().$executeRawUnsafe(
          `INSERT INTO "legal_acceptances" ("id","workspace_id","actor_user_id","legal_document_id","checkout_contract_id","locale","accepted_at")
           VALUES ('stale-acceptance','${workspaceId}','${ownerUserId}','${superseded.id}','${opened.checkoutContractId}','en',NOW())`,
        ),
      ).rejects.toThrow(/is superseded/u);
    });

    it("stops demanding a kind whose current version withdrew the requirement", async () => {
      // The opposite hole: an old version marked required went on demanding an acceptance after a newer
      // one had stopped requiring it, so nobody could complete a checkout the product no longer gated.
      await publishLegalDocument(db(), {
        kind: "PRIVACY_POLICY",
        locale: "en",
        contentRef: "https://legal.example.test/privacy/en/required",
        requiredForCheckout: true,
        effectiveFrom: new Date("2026-04-01T00:00:00.000Z"),
      });
      const { context } = await freshWorkspace();
      const withPrivacy = await readCheckoutOffer(db(), context, request(), NOW);
      expect(withPrivacy.available).toBe(true);
      if (withPrivacy.available) {
        expect(withPrivacy.documents.find((document) => document.kind === "PRIVACY_POLICY")?.requiredForCheckout).toBe(true);
      }

      await publishLegalDocument(db(), {
        kind: "PRIVACY_POLICY",
        locale: "en",
        contentRef: "https://legal.example.test/privacy/en/optional",
        requiredForCheckout: false,
        effectiveFrom: new Date("2026-05-01T00:00:00.000Z"),
      });

      const after = await readCheckoutOffer(db(), context, request(), NOW);
      expect(after.available).toBe(true);
      if (after.available) {
        // Still offered, as a link rather than a checkbox.
        expect(after.documents.find((document) => document.kind === "PRIVACY_POLICY")).toMatchObject({ requiredForCheckout: false, contentRef: "https://legal.example.test/privacy/en/optional" });
      }
      // And a checkout that ticks only what is still required commits, which is what the coverage
      // trigger has to agree with.
      const opened = await openFor(context, request());
      expect(opened.checkoutContractId).toBeTruthy();
    });

    it("agrees with the database about which kinds are required", async () => {
      // The requirement rule is written twice — in `readLegalDocumentOffers` and in SQL's
      // `current_legal_documents` — so this holds the two derivations against each other. A
      // disagreement is either a checkout that cannot commit or a consent nobody was asked for.
      const { context } = await freshWorkspace();
      const offer = await readCheckoutOffer(db(), context, request(), NOW);
      expect(offer.available).toBe(true);
      if (!offer.available) {
        return;
      }
      const sellerProfileId = (await db().billingRoute.findUniqueOrThrow({ where: { code: "direct-eu" }, select: { sellerProfileId: true } })).sellerProfileId;
      const rows = await db().$queryRawUnsafe<{ kind: string; required: boolean }[]>(
        // Explicit casts: the function takes TEXT and TIMESTAMP(3), and `NOW()` is a timestamptz.
        `SELECT "kind"::TEXT AS kind, bool_or("required_for_checkout") AS required
           FROM "current_legal_documents"('${sellerProfileId}'::TEXT, NOW()::TIMESTAMP(3))
          GROUP BY "kind"`,
      );
      const fromSql = new Map(rows.map((row) => [row.kind, row.required]));

      for (const document of offer.documents) {
        expect(fromSql.get(document.kind), document.kind).toBe(document.requiredForCheckout);
      }
      // And nothing the database thinks is required is missing from the screen.
      for (const [kind, required] of fromSql) {
        if (required) {
          expect(offer.documents.some((document) => document.kind === kind), kind).toBe(true);
        }
      }
    });
  });

  describe("what a reader can actually open", () => {
    it("refuses a published location that is not an https URL anybody could follow", async () => {
      // Every `contentRef` written under #46 was a path fragment, and as an `href` on the checkout route
      // a fragment resolves to a page that does not exist — a checkbox asking for consent to something
      // unreadable, which is the one thing this issue exists to prevent.
      for (const contentRef of ["terms/en/1", "", "http://legal.example.test/terms", "not a url", "//legal.example.test/terms"]) {
        await expect(
          publishLegalDocument(db(), { kind: "TERMS_OF_SERVICE", locale: "xx", contentRef, effectiveFrom: NOW }),
          contentRef,
        ).rejects.toThrow(DbInputError);
      }
    });

    it("refuses one written straight to the table too", async () => {
      await expect(
        db().$executeRawUnsafe(
          `INSERT INTO "legal_documents" ("id","kind","version","locale","content_ref","effective_from")
           VALUES ('raw-fragment','TERMS_OF_SERVICE',99,'xx','terms/en/1',NOW())`,
        ),
      ).rejects.toThrow(/legal_documents_content_ref_check/u);
    });

    it("offers every required document with a link somebody could follow", async () => {
      const { context } = await freshWorkspace();
      const offer = await readCheckoutOffer(db(), context, request(), NOW);

      expect(offer.available).toBe(true);
      if (offer.available) {
        expect(offer.documents.length).toBeGreaterThan(0);
        for (const document of offer.documents) {
          expect(new URL(document.contentRef).protocol, document.kind).toBe("https:");
          // And the date, because the version number counts publications across the catalogue and a
          // seller's first offer can be "version 2".
          expect(document.effectiveFrom, document.kind).toBeInstanceOf(Date);
        }
      }
    });
  });

  describe("a requirement that appeared after the page was drawn", () => {
    it("says the terms changed rather than blaming the reader for a box that was never there", async () => {
      const { context } = await freshWorkspace();
      const drawn = await readCheckoutOffer(db(), context, request(), NOW);
      const offeredIds = drawn.available ? drawn.documents.filter((document) => document.requiredForCheckout).map((document) => document.legalDocumentId) : [];

      // A kind nobody had published becomes effective, and required, between the GET and the POST.
      await publishLegalDocument(db(), {
        kind: "REFUND_POLICY",
        locale: "en",
        contentRef: "https://legal.example.test/refund/global/1",
        requiredForCheckout: true,
        effectiveFrom: new Date("2026-01-15T00:00:00.000Z"),
      });

      const blamed = await openCheckoutContract(db(), context, { ...request(), acceptedDocumentIds: offeredIds });
      const explained = await openCheckoutContract(db(), context, { ...request(), acceptedDocumentIds: offeredIds, offeredDocumentIds: offeredIds });

      // Without the token the store cannot tell the two apart, and says the honest conservative thing.
      expect(blamed).toMatchObject({ available: false, reason: "TERMS_NOT_ACCEPTED" });
      // With it, the refusal names what actually happened.
      expect(explained).toMatchObject({ available: false, reason: "DOCUMENT_SUPERSEDED" });
      if (!explained.available) {
        expect(explained.detail.join(" ")).toContain("REFUND_POLICY");
      }
    });

    it("still refuses a box the reader simply left unticked", async () => {
      // The other half, and the one the token must not weaken: the page rendered the tick, the person
      // did not use it, and `offeredDocumentIds` is the channel through which a client could claim
      // otherwise.
      const { context, workspaceId } = await freshWorkspace();
      const drawn = await readCheckoutOffer(db(), context, request(), NOW);
      const offeredIds = drawn.available ? drawn.documents.filter((document) => document.requiredForCheckout).map((document) => document.legalDocumentId) : [];
      expect(offeredIds.length).toBeGreaterThan(1);

      const refused = await openCheckoutContract(db(), context, {
        ...request(),
        acceptedDocumentIds: offeredIds.slice(0, 1),
        offeredDocumentIds: offeredIds,
      });

      expect(refused).toMatchObject({ available: false, reason: "TERMS_NOT_ACCEPTED" });
      expect(await db().checkoutContract.count({ where: { workspaceId } })).toBe(0);
      expect(await db().legalAcceptance.count({ where: { workspaceId } })).toBe(0);
    });
  });

  describe("the seller's own text, in the reader's language where there is one", () => {
    it("prefers the seller's own document over a better-translated global one", async () => {
      // Locale must not dominate specificity. A global `ru` offer alongside the seller's `en`-only one
      // would otherwise hand a Russian reader the platform's generic terms for a checkout whose contract
      // names that seller's legal entity and jurisdiction.
      await upsertSellerProfile(db(), {
        code: "seller-specific",
        legalName: "Specific SRL",
        displayName: "Specific",
        jurisdiction: "RO",
        supportEmail: "billing@specific.test",
      });
      await upsertBillingRoute(db(), {
        code: "specific-route",
        provider: "test-psp",
        sellerProfileCode: "seller-specific",
        settlementModel: "DIRECT_PSP",
        capabilities: ["RECURRING_SUBSCRIPTIONS", "VERIFIED_WEBHOOKS"],
        currencies: ["SEK"],
        intervals: ["MONTH"],
        enabled: true,
        priority: 1,
      });
      await db().planPrice.create({ data: { planVersionId, currency: "SEK", interval: "MONTH", amountCents: 55_000 } });
      await publishLegalDocument(db(), {
        kind: "PRIVACY_POLICY",
        locale: "ru",
        contentRef: "https://legal.example.test/privacy/global/ru",
        requiredForCheckout: true,
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      });
      await publishLegalDocument(db(), {
        kind: "PRIVACY_POLICY",
        locale: "en",
        contentRef: "https://legal.example.test/privacy/specific/en",
        sellerProfileCode: "seller-specific",
        requiredForCheckout: true,
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      });
      const { context } = await freshWorkspace();

      try {
        const offer = await readCheckoutOffer(db(), context, request({ currency: "SEK", locale: "ru" }), NOW);

        expect(offer.available).toBe(true);
        if (offer.available) {
          const privacy = offer.documents.find((document) => document.kind === "PRIVACY_POLICY");
          // The seller's own English text, not the platform's Russian one.
          expect(privacy).toMatchObject({ contentRef: "https://legal.example.test/privacy/specific/en", locale: "en", inViewerLanguage: false });
        }
      } finally {
        await db().billingRoute.update({ where: { code: "specific-route" }, data: { enabled: false } });
      }
    });
  });

  describe("a checkout nobody could settle", () => {
    it("is refused before anything is written, so it cannot block the next one", async () => {
      // The registry is process-local and empty for a provider nobody wired. A contract written anyway
      // would take the workspace's one live charge path and leave a PENDING arrangement behind it.
      await upsertBillingRoute(db(), {
        code: "unwired",
        provider: "provider-with-no-adapter",
        sellerProfileCode: "seller-ro",
        settlementModel: "DIRECT_PSP",
        capabilities: ["RECURRING_SUBSCRIPTIONS", "VERIFIED_WEBHOOKS"],
        currencies: ["EUR"],
        intervals: ["MONTH"],
        enabled: true,
        priority: 1,
      });
      const { context, workspaceId } = await freshWorkspace();
      try {
        const offer = await readCheckoutOffer(db(), context, request(), NOW);
        expect(offer).toMatchObject({ available: true, checkoutReady: false });

        const refused = await openCheckoutContract(db(), context, {
          ...request(),
          acceptedDocumentIds: offer.available ? offer.documents.filter((document) => document.requiredForCheckout).map((document) => document.legalDocumentId) : [],
        });

        expect(refused).toMatchObject({ available: false, reason: "PROVIDER_UNAVAILABLE" });
        expect(await db().checkoutContract.count({ where: { workspaceId } })).toBe(0);
        expect(await readArrangement(db(), workspaceId)).toBeNull();
      } finally {
        await db().billingRoute.update({ where: { code: "unwired" }, data: { enabled: false } });
      }
    });

    it("reports a route whose provider is wired as ready", async () => {
      const { context } = await freshWorkspace();

      expect(await readCheckoutOffer(db(), context, request(), NOW)).toMatchObject({ available: true, checkoutReady: true });
    });
  });

  describe("the acceptance record itself", () => {
    it("has exactly the columns it is meant to have, so an added one has to be argued for", async () => {
      // The issue says no payment or card data is stored in acceptance records. A denylist of card-shaped
      // words would pass for any column #47 could add, so this asserts the whole set: a new column fails
      // here and has to be explained rather than noticed.
      const columns = await db().$queryRawUnsafe<{ column_name: string }[]>(
        `SELECT "column_name" FROM information_schema.columns WHERE "table_name" = 'legal_acceptances'`,
      );

      expect(columns.map((column) => column.column_name).sort()).toEqual([
        "accepted_at",
        "actor_user_id",
        "checkout_contract_id",
        "created_at",
        "id",
        "legal_document_id",
        "locale",
        "workspace_id",
      ]);
    });

    it("canonicalizes the language it stores, so one language is not several spellings", async () => {
      const { context } = await freshWorkspace();
      const opened = await openCheckoutContract(db(), context, {
        ...request({ locale: "RU-ru" }),
        acceptedDocumentIds: await acceptedIds(context, request({ locale: "RU-ru" })),
      });

      expect(opened.available).toBe(true);
      if (opened.available) {
        const stored = await db().legalAcceptance.findMany({ where: { checkoutContractId: opened.checkoutContractId }, select: { locale: true } });
        expect(stored.map((row) => row.locale)).toEqual(stored.map(() => "ru-RU"));
      }
    });

    it("refuses a locale that is not a language tag at all", async () => {
      const { context } = await freshWorkspace();

      await expect(openCheckoutContract(db(), context, { ...request({ locale: "not a tag" }), acceptedDocumentIds: [] })).rejects.toThrow(DbInputError);
    });

    it("never throws for a locale nobody published, in any of the product's own locales", async () => {
      // The invariant the #46 defect broke, and the one worth holding permanently: a checkout either
      // succeeds or comes back with a reason. It never reaches a page as a Postgres sentence.
      const { context } = await freshWorkspace();
      for (const locale of ["en", "ru", "de", "zh-Hant"]) {
        const offer = await readCheckoutOffer(db(), context, request({ locale }), NOW);
        expect(offer.available || CHECKOUT_REFUSALS.includes(offer.reason), locale).toBe(true);

        const attempt = await openCheckoutContract(db(), context, {
          ...request({ locale }),
          acceptedDocumentIds: offer.available ? offer.documents.filter((document) => document.requiredForCheckout).map((document) => document.legalDocumentId) : [],
        });
        if (!attempt.available) {
          expect(CHECKOUT_REFUSALS.includes(attempt.reason), locale).toBe(true);
        }
        if (attempt.available) {
          // One live charge path per workspace, so the next locale needs its own workspace. Released
          // rather than left behind, which is what the sweeper would otherwise have to do.
          await db().billingArrangement.update({ where: { id: attempt.arrangementId }, data: { state: "ENDED", endedAt: NOW } });
        }
      }
    });

    it("is not rewritten when a new document version is published", async () => {
      const { context } = await freshWorkspace();
      const opened = await openFor(context, request());
      const before = await db().legalAcceptance.findMany({
        where: { checkoutContractId: opened.checkoutContractId },
        orderBy: { legalDocumentId: "asc" },
        select: { legalDocumentId: true, locale: true, acceptedAt: true },
      });

      await publishLegalDocument(db(), {
        kind: "TERMS_OF_SERVICE",
        locale: "en",
        contentRef: "https://legal.example.test/terms/en/after-acceptance",
        effectiveFrom: new Date("2026-06-01T00:00:00.000Z"),
      });

      const after = await db().legalAcceptance.findMany({
        where: { checkoutContractId: opened.checkoutContractId },
        orderBy: { legalDocumentId: "asc" },
        select: { legalDocumentId: true, locale: true, acceptedAt: true },
      });

      // Historical acceptance names the version that was accepted, for ever. A newer one existing is not
      // a reason to say somebody agreed to it.
      expect(after).toEqual(before);
      // And the other half, which is what makes this test able to fail: the version that was accepted is
      // no longer one a *new* checkout may accept.
      const { context: second } = await freshWorkspace();
      const staleRefusal = await openCheckoutContract(db(), second, {
        ...request(),
        acceptedDocumentIds: before.map((row) => row.legalDocumentId),
      });
      expect(staleRefusal).toMatchObject({ available: false, reason: "DOCUMENT_SUPERSEDED" });
    });
  });

  describe("route isolation between workspaces", () => {
    it("keeps one workspace's charge path and acceptances invisible to another", async () => {
      const first = await freshWorkspace();
      const second = await freshWorkspace();
      const opened = await openFor(first.context, request());

      expect(await readArrangement(db(), second.workspaceId)).toBeNull();
      const theirAudit = await searchAuditEvents(db(), second.context, { kinds: ["CHECKOUT_OPENED"] });
      expect(theirAudit.rows.some((event) => event.subjectId === opened.checkoutContractId)).toBe(false);
      expect(await db().legalAcceptance.count({ where: { workspaceId: second.workspaceId } })).toBe(0);
    });

    it("refuses an acceptance filed under a workspace that is not the checkout's", async () => {
      const first = await freshWorkspace();
      const second = await freshWorkspace();
      const opened = await openFor(first.context, request());
      const document = await db().legalDocument.findFirstOrThrow({ where: { contentRef: "https://legal.example.test/terms/en/1" }, select: { id: true } });

      await expect(
        db().$executeRawUnsafe(
          `INSERT INTO "legal_acceptances" ("id","workspace_id","actor_user_id","legal_document_id","checkout_contract_id","accepted_at")
           VALUES ('cross-tenant-acceptance','${second.workspaceId}','${second.ownerUserId}','${document.id}','${opened.checkoutContractId}',NOW())`,
        ),
      ).rejects.toThrow(/belongs to the workspace whose checkout/u);
    });
  });

});
