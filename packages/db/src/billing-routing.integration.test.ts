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
  type LegalDocumentOffer,
  type OpenCheckoutInput,
  type OpenedCheckout,
} from "./billing-routing-store";
import { ACCEPTED_PLANS, publishAcceptedCatalog } from "./accepted-catalog";
import { publishPlanVersion, readEntitlement, requestCancellation, resumeSubscription } from "./entitlement-store";
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

    it("does not let a renewal undo a cancellation the customer asked for", async () => {
      const { context, workspaceId } = await freshWorkspace();
      const opened = await openFor(context, request({}));
      await recordVerifiedBillingEvent(
        db(),
        verified("test-psp", {
          routeCode: "direct-eu",
          providerEventId: `cancel-then-renew-settled-${workspaceId}`,
          kind: "PAYMENT_SETTLED",
          occurredAt: NOW,
          checkoutContractId: opened.checkoutContractId,
          settled: money(4_900, "EUR"),
        }),
        NOW,
      );
      const cancelled = await requestCancellation(db(), context, NOW);
      expect(cancelled).toMatchObject({ status: "CANCELING" });
      const periodEnd = (await readArrangement(db(), workspaceId))?.currentPeriodEnd;

      // The provider renews anyway — which it will, because nothing tells it to stop: the cancellation is
      // recorded locally and `setProviderRenewal` has no caller. That gap is reported separately; what is
      // proved here is that the renewal cannot flip the customer's decision back.
      const renewal = await recordVerifiedBillingEvent(
        db(),
      // Not awaited: `verified` is synchronous on this branch, and `await` on a non-Thenable is an
      // eslint error under `--max-warnings=0`. It becomes asynchronous from #104, where the provider port
      // gains its three-way `VerifiedDelivery`, and the merge into that branch adds the `await` there —
      // each branch carrying the form its own helper requires, rather than a wart that suits neither.
        verified("test-psp", {
          routeCode: "direct-eu",
          providerEventId: `cancel-then-renew-${workspaceId}`,
          kind: "SUBSCRIPTION_RENEWED",
          occurredAt: NOW,
          arrangementId: opened.arrangementId,
        }),
        NOW,
      );

      // Recorded, never resurrected — the rule `ACTIVATE` already applies to an ended arrangement.
      expect(renewal).toMatchObject({ outcome: "APPLIED", effect: "NONE" });
      expect(await readEntitlement(db(), workspaceId, NOW)).toMatchObject({ state: "CANCELED_PENDING_END" });
      // The arrangement is left alone too: a moved period end would read like a live renewal underneath a
      // subscription that is ending.
      expect((await readArrangement(db(), workspaceId))?.currentPeriodEnd?.toISOString()).toBe(periodEnd?.toISOString());
      // And the event is still written and audited, which is what makes the divergence findable.
      const audits = await searchAuditEvents(db(), context, { kinds: ["BILLING_ARRANGEMENT_CHANGED"] });
      expect(audits.rows.some((row) => row.summary.includes("SUBSCRIPTION_RENEWED") && row.summary.includes("NONE"))).toBe(true);
    });

    it("extends again once the customer withdraws the cancellation themselves", async () => {
      const { context, workspaceId } = await freshWorkspace();
      const opened = await openFor(context, request({}));
      await recordVerifiedBillingEvent(
        db(),
        verified("test-psp", {
          routeCode: "direct-eu",
          providerEventId: `resume-settled-${workspaceId}`,
          kind: "PAYMENT_SETTLED",
          occurredAt: NOW,
          checkoutContractId: opened.checkoutContractId,
          settled: money(4_900, "EUR"),
        }),
        NOW,
      );
      await requestCancellation(db(), context, NOW);
      expect(await resumeSubscription(db(), context, NOW)).toMatchObject({ status: "RESUMED" });

      const renewal = await recordVerifiedBillingEvent(
        db(),
      // Not awaited: `verified` is synchronous on this branch, and `await` on a non-Thenable is an
      // eslint error under `--max-warnings=0`. It becomes asynchronous from #104, where the provider port
      // gains its three-way `VerifiedDelivery`, and the merge into that branch adds the `await` there —
      // each branch carrying the form its own helper requires, rather than a wart that suits neither.
        verified("test-psp", {
          routeCode: "direct-eu",
          providerEventId: `resume-renewed-${workspaceId}`,
          kind: "SUBSCRIPTION_RENEWED",
          occurredAt: NOW,
          arrangementId: opened.arrangementId,
        }),
        NOW,
      );

      // The positive control. Without it the guard above would pass just as happily if renewals had
      // stopped working altogether, which is the failure this whole class is made of.
      expect(renewal).toMatchObject({ outcome: "APPLIED", effect: "EXTEND" });
      expect(await readEntitlement(db(), workspaceId, NOW)).toMatchObject({ state: "ACTIVE" });
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

    /**
     * Astra's second blocking finding on PR #100: a delayed renewal moved the paid-through date
     * *backwards*. The maximum the code computed only guarded the fallback it uses when a provider states
     * no period of its own — so a provider that does state one, which is the normal case, wrote its value
     * straight into the subscription. Event-id idempotency cannot help: a reordered delivery is a
     * different event, legitimately processed, carrying an older term.
     */
    const FIRST_END = new Date("2026-11-07T12:00:00.000Z");
    const LATER_END = new Date("2026-12-07T12:00:00.000Z");
    const LATER_STILL = new Date("2027-01-07T12:00:00.000Z");
    const RENEW_AT = new Date("2026-11-01T12:00:00.000Z");

    async function paidThrough(label: string, end: Date) {
      const { context, workspaceId } = await freshWorkspace();
      const opened = await openFor(context, request());
      await recordVerifiedBillingEvent(
        db(),
        verified("test-psp", {
          routeCode: "direct-eu",
          providerEventId: `${label}-settled-${workspaceId}`,
          kind: "PAYMENT_SETTLED",
          occurredAt: NOW,
          checkoutContractId: opened.checkoutContractId,
          settled: money(4_900, "EUR"),
          periodEndsAt: end,
        }),
        NOW,
      );
      return { context, workspaceId, opened };
    }

    it("will not let a renewal that arrives late move the paid term backwards", async () => {
      const { workspaceId, opened } = await paidThrough("reorder", LATER_END);

      const stale = await recordVerifiedBillingEvent(
        db(),
        verified("test-psp", {
          routeCode: "direct-eu",
          providerEventId: `reorder-stale-${workspaceId}`,
          kind: "SUBSCRIPTION_RENEWED",
          occurredAt: RENEW_AT,
          arrangementId: opened.arrangementId,
          settled: money(4_900, "EUR"),
          // An earlier term than the one already paid for: the February renewal arriving after March's.
          periodEndsAt: FIRST_END,
        }),
        RENEW_AT,
      );

      // Recorded and audited, because the divergence is worth seeing — but it changes nothing.
      expect(stale).toMatchObject({ outcome: "APPLIED", effect: "NONE" });
      expect(await db().workspaceSubscription.findUniqueOrThrow({ where: { workspaceId }, select: { state: true, periodEndsAt: true } })).toEqual({
        state: "ACTIVE",
        periodEndsAt: LATER_END,
      });
      expect(await db().billingArrangement.findUniqueOrThrow({ where: { id: opened.arrangementId }, select: { currentPeriodEnd: true } })).toEqual({
        currentPeriodEnd: LATER_END,
      });
      // And the access it would have taken away is still there.
      expect((await readEntitlement(db(), workspaceId, new Date("2026-11-20T12:00:00.000Z"))).paidWorkAllowed).toBe(true);
    });

    it("cannot be made to grant service by moving a date while a lookup is pending", async () => {
      // Astra's second re-review finding, and the one a synchronous test cannot reach. Asserting at the
      // entry point answers a question about one instant; the store then awaits a route lookup, a
      // transaction and several queries, and a caller that still holds the object it passed in can move a
      // `Date` inside it while any of those are pending. Re-asserting after each await would not close it,
      // because there is always another await — so the entry point copies the authenticated facts out and
      // everything downstream reads the copy.
      //
      // This drives the real store against the real database, with only the route lookup gated, because
      // the window being tested is one that exists between awaits rather than inside a mock.
      const { workspaceId, opened } = await paidThrough("interleaved", FIRST_END);
      const event = verified("test-psp", {
        routeCode: "direct-eu",
        providerEventId: `interleaved-renewed-${workspaceId}`,
        kind: "SUBSCRIPTION_RENEWED",
        occurredAt: RENEW_AT,
        arrangementId: opened.arrangementId,
        settled: money(4_900, "EUR"),
        periodEndsAt: LATER_END,
      });

      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const real = db();
      const gated = new Proxy(real, {
        get(target, property, receiver) {
          if (property === "billingRoute") {
            return {
              ...target.billingRoute,
              findUnique: async (args: Parameters<typeof real.billingRoute.findUnique>[0]) => {
                await gate;
                return real.billingRoute.findUnique(args);
              },
            };
          }
          return Reflect.get(target, property, receiver) as unknown;
        },
      });

      const processing = recordVerifiedBillingEvent(gated, event, RENEW_AT);
      // The caller still holds the event, and the lookup has not returned yet.
      event.periodEndsAt?.setUTCFullYear(2099);
      release();
      const result = await processing;

      // The renewal it was minted for still applies, and the year it was moved to never reaches a row.
      expect(result).toMatchObject({ outcome: "APPLIED", effect: "EXTEND" });
      expect(await db().workspaceSubscription.findUniqueOrThrow({ where: { workspaceId }, select: { periodEndsAt: true } })).toEqual({ periodEndsAt: LATER_END });
      expect(await db().billingArrangement.findUniqueOrThrow({ where: { id: opened.arrangementId }, select: { currentPeriodEnd: true } })).toEqual({
        currentPeriodEnd: LATER_END,
      });
      // And the event row records the term that was authenticated, not the one somebody wrote afterwards.
      const row = await db().billingEvent.findFirstOrThrow({ where: { providerEventId: `interleaved-renewed-${workspaceId}` }, select: { detail: true } });
      expect(JSON.stringify(row.detail)).not.toContain("2099");
    });

    it("still extends when the renewal genuinely buys more time", async () => {
      // The control. A fix that answered `NONE` to every renewal would pass the case above and silently
      // stop renewing anybody's subscription, which is a worse defect than the one being fixed.
      const { workspaceId, opened } = await paidThrough("forward", FIRST_END);

      const extended = await recordVerifiedBillingEvent(
        db(),
        verified("test-psp", {
          routeCode: "direct-eu",
          providerEventId: `forward-renewed-${workspaceId}`,
          kind: "SUBSCRIPTION_RENEWED",
          occurredAt: RENEW_AT,
          arrangementId: opened.arrangementId,
          settled: money(4_900, "EUR"),
          periodEndsAt: LATER_END,
        }),
        RENEW_AT,
      );

      expect(extended).toMatchObject({ outcome: "APPLIED", effect: "EXTEND" });
      expect(await db().workspaceSubscription.findUniqueOrThrow({ where: { workspaceId }, select: { periodEndsAt: true } })).toEqual({ periodEndsAt: LATER_END });
    });

    it("keeps the furthest term when two renewals with different identifiers race", async () => {
      // Distinct event ids, so idempotency does not serialize them, and the two transactions genuinely
      // interleave. Whichever lands second, the workspace must end up with the later term: the loser of
      // the race is a renewal that bought less time, not a correction.
      const { workspaceId, opened } = await paidThrough("race", FIRST_END);

      const renewal = (suffix: string, end: Date) =>
        recordVerifiedBillingEvent(
          db(),
          verified("test-psp", {
            routeCode: "direct-eu",
            providerEventId: `race-${suffix}-${workspaceId}`,
            kind: "SUBSCRIPTION_RENEWED",
            occurredAt: RENEW_AT,
            arrangementId: opened.arrangementId,
            settled: money(4_900, "EUR"),
            periodEndsAt: end,
          }),
          RENEW_AT,
        );

      const [near, far] = await Promise.all([renewal("near", LATER_END), renewal("far", LATER_STILL)]);

      // Both were processed — neither is a duplicate — and between them exactly one extended the term.
      expect([near.outcome, far.outcome]).toEqual(["APPLIED", "APPLIED"]);
      expect([near.effect, far.effect].filter((effect) => effect === "EXTEND").length).toBeGreaterThanOrEqual(1);
      expect(await db().workspaceSubscription.findUniqueOrThrow({ where: { workspaceId }, select: { periodEndsAt: true } })).toEqual({ periodEndsAt: LATER_STILL });
      expect(await db().billingArrangement.findUniqueOrThrow({ where: { id: opened.arrangementId }, select: { currentPeriodEnd: true } })).toEqual({
        currentPeriodEnd: LATER_STILL,
      });
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

    it("will not put the live path into grace when the old provider's payment fails afterwards", async () => {
      // The twin of the case above, and the one that was wrong. `ACTIVATE` refuses a superseded
      // arrangement and `END` refuses one too, but `SUSPEND` did not look at the arrangement at all: it
      // read the subscription and wrote `GRACE`. So a failed charge on the path a workspace had already
      // been moved off suspended the path it is actually paying on, and the customer lost paid access
      // because of a provider they no longer use. The old provider retrying a dead subscription is the
      // ordinary case, not an exotic one.
      const { context, workspaceId } = await freshWorkspace();
      const first = await openFor(context, request());
      await recordVerifiedBillingEvent(
        db(),
        verified("test-psp", {
          routeCode: "direct-eu",
          providerEventId: `superseded-settled-${workspaceId}`,
          kind: "PAYMENT_SETTLED",
          occurredAt: NOW,
          checkoutContractId: first.checkoutContractId,
          settled: money(4_900, "EUR"),
          providerReference: "sub_old_provider",
        }),
        NOW,
      );

      await db().billingRoute.update({ where: { code: "direct-eu" }, data: { enabled: false } });
      const second = await openFor(context, request({ supersedeCurrent: true }));
      await db().billingRoute.update({ where: { code: "direct-eu" }, data: { enabled: true } });
      await recordVerifiedBillingEvent(
        db(),
        verified("test-mor", {
          routeCode: "mor-global",
          providerEventId: `superseded-migrated-${workspaceId}`,
          kind: "PAYMENT_SETTLED",
          occurredAt: NOW,
          checkoutContractId: second.checkoutContractId,
          settled: money(4_900, "EUR"),
          providerReference: "sub_new_provider",
        }),
        NOW,
      );

      // Asserted before the failure arrives. A fixture that never reached a paying state would make the
      // assertion afterwards pass without the guard existing, which is the way this kind of test lies.
      expect(await db().billingArrangement.findUniqueOrThrow({ where: { id: first.arrangementId }, select: { state: true } })).toEqual({
        state: "SUPERSEDED",
      });
      expect(await db().workspaceSubscription.findUniqueOrThrow({ where: { workspaceId }, select: { state: true } })).toEqual({ state: "ACTIVE" });

      const failed = await recordVerifiedBillingEvent(
        db(),
        verified("test-psp", {
          routeCode: "direct-eu",
          providerEventId: `superseded-failed-${workspaceId}`,
          kind: "PAYMENT_FAILED",
          occurredAt: NOW,
          checkoutContractId: first.checkoutContractId,
        }),
        NOW,
      );

      expect(failed).toMatchObject({ outcome: "APPLIED", effect: "NONE" });
      expect(
        await db().workspaceSubscription.findUniqueOrThrow({ where: { workspaceId }, select: { state: true, graceStartedAt: true } }),
      ).toEqual({ state: "ACTIVE", graceStartedAt: null });
      expect((await readEntitlement(db(), workspaceId, NOW)).paidWorkAllowed).toBe(true);
    });

    it("will not let a refund of the superseded term revoke the term that replaced it", async () => {
      // #44 requires this one by name: a reversal of an older paid term cannot revoke a newer valid
      // arrangement. The guard is the same one `ACTIVATE` and `SUSPEND` use, and `END` already had it —
      // what was missing is any case saying so, and a refund arriving months late for a provider the
      // workspace has left is exactly when nobody is watching. Ending the live path here would cut off a
      // paying customer on the strength of money being returned for something else.
      const { context, workspaceId } = await freshWorkspace();
      const first = await openFor(context, request());
      await recordVerifiedBillingEvent(
        db(),
        verified("test-psp", {
          routeCode: "direct-eu",
          providerEventId: `reversal-old-settled-${workspaceId}`,
          kind: "PAYMENT_SETTLED",
          occurredAt: NOW,
          checkoutContractId: first.checkoutContractId,
          settled: money(4_900, "EUR"),
        }),
        NOW,
      );
      await db().billingRoute.update({ where: { code: "direct-eu" }, data: { enabled: false } });
      const second = await openFor(context, request({ supersedeCurrent: true }));
      await db().billingRoute.update({ where: { code: "direct-eu" }, data: { enabled: true } });
      await recordVerifiedBillingEvent(
        db(),
        verified("test-mor", {
          routeCode: "mor-global",
          providerEventId: `reversal-new-settled-${workspaceId}`,
          kind: "PAYMENT_SETTLED",
          occurredAt: NOW,
          checkoutContractId: second.checkoutContractId,
          settled: money(4_900, "EUR"),
        }),
        NOW,
      );

      expect(await db().workspaceSubscription.findUniqueOrThrow({ where: { workspaceId }, select: { state: true } })).toEqual({ state: "ACTIVE" });

      // Both reversal kinds, because they are two rows in the mapping and only one of them would have to
      // be wrong for a refund to end a subscription somebody is paying for.
      for (const kind of ["REFUNDED", "CHARGEBACK"] as const) {
        const reversed = await recordVerifiedBillingEvent(
          db(),
          verified("test-psp", {
            routeCode: "direct-eu",
            providerEventId: `reversal-${kind}-${workspaceId}`,
            kind,
            occurredAt: NOW,
            arrangementId: first.arrangementId,
          }),
          NOW,
        );

        expect(reversed, kind).toMatchObject({ outcome: "APPLIED", effect: "NONE" });
      }

      // The new arrangement is still the live one and still the only live one.
      const live = await db().billingArrangement.findMany({ where: { workspaceId, state: { in: ["PENDING", "ACTIVE"] } }, select: { id: true } });
      expect(live).toEqual([{ id: second.arrangementId }]);
      expect(await db().workspaceSubscription.findUniqueOrThrow({ where: { workspaceId }, select: { state: true, canceledAt: true } })).toEqual({
        state: "ACTIVE",
        canceledAt: null,
      });
      expect((await readEntitlement(db(), workspaceId, NOW)).paidWorkAllowed).toBe(true);
    });

    it("will not put a workspace into grace for a failure naming an arrangement its route does not own", async () => {
      // The same hole reached the other way. The arrangement is looked up with the event's route in the
      // predicate, so an identifier belonging to another route resolves to nothing — and the workspace
      // still came back from the contract, which was enough for the unguarded branch to write `GRACE`.
      // `END` refuses an absent arrangement already; this makes the two agree.
      const { context: paying, workspaceId } = await freshWorkspace();
      const elsewhere = await freshWorkspace();
      const opened = await openFor(paying, request());
      await recordVerifiedBillingEvent(
        db(),
        verified("test-psp", {
          routeCode: "direct-eu",
          providerEventId: `foreign-settled-${workspaceId}`,
          kind: "PAYMENT_SETTLED",
          occurredAt: NOW,
          checkoutContractId: opened.checkoutContractId,
          settled: money(4_900, "EUR"),
        }),
        NOW,
      );
      await db().billingRoute.update({ where: { code: "direct-eu" }, data: { enabled: false } });
      const foreign = await openFor(elsewhere.context, request());
      await db().billingRoute.update({ where: { code: "direct-eu" }, data: { enabled: true } });

      const failed = await recordVerifiedBillingEvent(
        db(),
        verified("test-psp", {
          routeCode: "direct-eu",
          providerEventId: `foreign-failed-${workspaceId}`,
          kind: "PAYMENT_FAILED",
          occurredAt: NOW,
          checkoutContractId: opened.checkoutContractId,
          // An arrangement on `mor-global`, so it cannot be found under `direct-eu`.
          arrangementId: foreign.arrangementId,
        }),
        NOW,
      );

      expect(failed).toMatchObject({ outcome: "APPLIED", effect: "NONE" });
      expect(
        await db().workspaceSubscription.findUniqueOrThrow({ where: { workspaceId }, select: { state: true, graceStartedAt: true } }),
      ).toEqual({ state: "ACTIVE", graceStartedAt: null });
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

    /**
     * Astra's first blocking finding on PR #100, by name: an older-term reversal revoked a newer paid term
     * on the **same** arrangement. The superseded-arrangement case above did not cover it — there the two
     * terms are two rows, and `END` already refused to touch a live path for a dead one. Here there is one
     * arrangement, one route and two consecutive paid terms, so nothing structural distinguishes them and
     * the only thing that can is attribution.
     */
    const TERM_ONE_END = new Date("2026-11-07T12:00:00.000Z");
    const RENEWED_AT = new Date("2026-11-01T12:00:00.000Z");
    const TERM_TWO_END = new Date("2026-12-07T12:00:00.000Z");
    const AFTER_RENEWAL = new Date("2026-11-02T12:00:00.000Z");
    const TERM_THREE_END = new Date("2027-01-07T12:00:00.000Z");

    /** Settles the first term and renews into a second one, both on a single arrangement. */
    async function twoPaidTerms(label: string) {
      const { context, workspaceId } = await freshWorkspace();
      const opened = await openFor(context, request());
      await recordVerifiedBillingEvent(
        db(),
        verified("test-psp", {
          routeCode: "direct-eu",
          providerEventId: `${label}-settled-${workspaceId}`,
          kind: "PAYMENT_SETTLED",
          occurredAt: NOW,
          checkoutContractId: opened.checkoutContractId,
          settled: money(4_900, "EUR"),
          periodEndsAt: TERM_ONE_END,
        }),
        NOW,
      );
      const renewed = await recordVerifiedBillingEvent(
        db(),
        verified("test-psp", {
          routeCode: "direct-eu",
          providerEventId: `${label}-renewed-${workspaceId}`,
          kind: "SUBSCRIPTION_RENEWED",
          occurredAt: RENEWED_AT,
          arrangementId: opened.arrangementId,
          settled: money(4_900, "EUR"),
          periodEndsAt: TERM_TWO_END,
        }),
        RENEWED_AT,
      );
      expect(renewed, "the second term has to be bought before a reversal of the first means anything").toMatchObject({
        outcome: "APPLIED",
        effect: "EXTEND",
      });
      return { context, workspaceId, opened };
    }

    for (const kind of ["REFUNDED", "CHARGEBACK"] as const) {
      it(`will not let a ${kind} naming the first term revoke the second one on the same arrangement`, async () => {
        const { workspaceId, opened } = await twoPaidTerms(`same-arr-stated-${kind}`);

        const reversed = await recordVerifiedBillingEvent(
          db(),
          verified("test-psp", {
            routeCode: "direct-eu",
            providerEventId: `same-arr-stated-${kind}-${workspaceId}`,
            kind,
            occurredAt: NOW,
            arrangementId: opened.arrangementId,
            settled: money(4_900, "EUR"),
            // The provider says which term it is taking back, and it is the one that has already elapsed.
            periodEndsAt: TERM_ONE_END,
          }),
          AFTER_RENEWAL,
        );

        expect(reversed, kind).toMatchObject({ outcome: "APPLIED", effect: "NONE" });
        // Read the rows back rather than trusting the effect: the defect wrote `INACTIVE` and `ENDED`.
        expect(await db().workspaceSubscription.findUniqueOrThrow({ where: { workspaceId }, select: { state: true, periodEndsAt: true, canceledAt: true } })).toEqual({
          state: "ACTIVE",
          periodEndsAt: TERM_TWO_END,
          canceledAt: null,
        });
        expect(await db().billingArrangement.findUniqueOrThrow({ where: { id: opened.arrangementId }, select: { state: true, endedAt: true, currentPeriodEnd: true } })).toEqual({
          state: "ACTIVE",
          endedAt: null,
          currentPeriodEnd: TERM_TWO_END,
        });
        expect((await readEntitlement(db(), workspaceId, AFTER_RENEWAL)).paidWorkAllowed).toBe(true);
      });
    }

    it("will not let a reversal that names no term at all revoke a term bought after it", async () => {
      // The half the ledger answers. Plenty of providers send a reversal with no period on it, and the
      // first version of this fix treated that as "ambiguous, so leave everything alone" — which broke the
      // ordinary case of refunding the only payment ever made. What distinguishes them is retained: the
      // event that granted the term in force occurred *after* the payment being taken back.
      const { workspaceId, opened } = await twoPaidTerms("same-arr-unstated");

      const reversed = await recordVerifiedBillingEvent(
        db(),
        verified("test-psp", {
          routeCode: "direct-eu",
          providerEventId: `same-arr-unstated-${workspaceId}`,
          kind: "REFUNDED",
          occurredAt: NOW,
          arrangementId: opened.arrangementId,
          settled: money(4_900, "EUR"),
        }),
        AFTER_RENEWAL,
      );

      expect(reversed).toMatchObject({ outcome: "APPLIED", effect: "NONE" });
      expect(await db().workspaceSubscription.findUniqueOrThrow({ where: { workspaceId }, select: { state: true, periodEndsAt: true } })).toEqual({
        state: "ACTIVE",
        periodEndsAt: TERM_TWO_END,
      });
    });

    for (const kind of ["REFUNDED", "CHARGEBACK"] as const) {
      it(`will not let a ${kind} raised after the renewal revoke it when no period is stated`, async () => {
        // Astra's re-review finding, and the hole in the first version of this fix. A reversal's
        // `occurredAt` is when the *reversal* was raised, not when the charge it reverses was made — so a
        // refund issued today for last month's invoice is legitimately newer than today's renewal, and the
        // timestamp comparison the first fix used let exactly this through. The case the earlier
        // regression covered was an *old* reversal delivered late, which is the easy half.
        const { workspaceId, opened } = await twoPaidTerms(`new-reversal-old-charge-${kind}`);

        const reversed = await recordVerifiedBillingEvent(
          db(),
          verified("test-psp", {
            routeCode: "direct-eu",
            providerEventId: `new-reversal-old-charge-${kind}-${workspaceId}`,
            kind,
            // Raised *after* the renewal that bought the term in force.
            occurredAt: AFTER_RENEWAL,
            arrangementId: opened.arrangementId,
            settled: money(4_900, "EUR"),
            // And naming no term, so only identity can attribute it.
          }),
          AFTER_RENEWAL,
        );

        expect(reversed, kind).toMatchObject({ outcome: "APPLIED", effect: "NONE" });
        expect(await db().workspaceSubscription.findUniqueOrThrow({ where: { workspaceId }, select: { state: true, periodEndsAt: true, canceledAt: true } })).toEqual({
          state: "ACTIVE",
          periodEndsAt: TERM_TWO_END,
          canceledAt: null,
        });
        expect(await db().billingArrangement.findUniqueOrThrow({ where: { id: opened.arrangementId }, select: { state: true, endedAt: true } })).toEqual({
          state: "ACTIVE",
          endedAt: null,
        });
        expect((await readEntitlement(db(), workspaceId, AFTER_RENEWAL)).paidWorkAllowed).toBe(true);
      });
    }

    it("still revokes an ordinary refund of the only payment ever made, whatever it states", async () => {
      // The control that stops the identity check turning into "a reversal naming nothing never does
      // anything". One payment has granted a term on this arrangement, so there is no other term it could
      // be about: the money being returned is the money that bought the access.
      const { context, workspaceId } = await freshWorkspace();
      const opened = await openFor(context, request());
      await recordVerifiedBillingEvent(
        db(),
        verified("test-psp", {
          routeCode: "direct-eu",
          providerEventId: `single-settled-${workspaceId}`,
          kind: "PAYMENT_SETTLED",
          occurredAt: NOW,
          checkoutContractId: opened.checkoutContractId,
          settled: money(4_900, "EUR"),
          periodEndsAt: TERM_ONE_END,
        }),
        NOW,
      );

      const reversed = await recordVerifiedBillingEvent(
        db(),
        verified("test-psp", {
          routeCode: "direct-eu",
          providerEventId: `single-refunded-${workspaceId}`,
          kind: "REFUNDED",
          // Raised later than the payment, naming no term and no reference: the shape a minimal provider
          // sends, and the one an over-cautious guard would wrongly ignore.
          occurredAt: new Date("2026-10-20T12:00:00.000Z"),
          arrangementId: opened.arrangementId,
          settled: money(4_900, "EUR"),
        }),
        new Date("2026-10-20T12:00:00.000Z"),
      );

      expect(reversed).toMatchObject({ outcome: "APPLIED", effect: "END" });
      expect(await db().workspaceSubscription.findUniqueOrThrow({ where: { workspaceId }, select: { state: true } })).toEqual({ state: "INACTIVE" });
      expect((await readEntitlement(db(), workspaceId, new Date("2026-10-20T12:00:00.000Z"))).paidWorkAllowed).toBe(false);
    });

    it("revokes the current term when the reversal states the period that term covers", async () => {
      // The genuine current-charge control. A previous version of this suite used a matching
      // `providerReference` as the proof, and Astra was right that it is not one: the interface permits a
      // *subscription* id there, which two separately paid terms legitimately share. What the payload can
      // actually prove is the period, so that is what this asserts.
      const { workspaceId, opened } = await twoPaidTerms("states-current-term");

      const reversed = await recordVerifiedBillingEvent(
        db(),
        verified("test-psp", {
          routeCode: "direct-eu",
          providerEventId: `states-current-term-${workspaceId}`,
          kind: "REFUNDED",
          occurredAt: AFTER_RENEWAL,
          arrangementId: opened.arrangementId,
          settled: money(4_900, "EUR"),
          periodEndsAt: TERM_TWO_END,
        }),
        AFTER_RENEWAL,
      );

      expect(reversed).toMatchObject({ outcome: "APPLIED", effect: "END" });
      expect(await db().workspaceSubscription.findUniqueOrThrow({ where: { workspaceId }, select: { state: true } })).toEqual({ state: "INACTIVE" });
      // The charge path ends with it. Asserted here because this case absorbed an earlier one that
      // checked it — see the note in the handoff: that test was removed by accident while this block
      // replaced its neighbour, and the assertion is carried over rather than quietly dropped.
      expect(await db().billingArrangement.findUniqueOrThrow({ where: { id: opened.arrangementId }, select: { state: true } })).toEqual({ state: "ENDED" });
      expect((await readEntitlement(db(), workspaceId, AFTER_RENEWAL)).paidWorkAllowed).toBe(false);
    });

    for (const kind of ["REFUNDED", "CHARGEBACK"] as const) {
      it(`will not let a ${kind} sharing the subscription reference revoke a separately paid term`, async () => {
        // Astra's round-three finding. `providerReference` is documented as the provider's subscription
        // *or* charge object, so on a recurring arrangement both paid terms carry the same value and a
        // refund of the first charge is indistinguishable from one of the second by that field alone.
        const { context, workspaceId } = await freshWorkspace();
        const opened = await openFor(context, request());
        await recordVerifiedBillingEvent(
          db(),
          verified("test-psp", {
            routeCode: "direct-eu",
            providerEventId: `shared-ref-settled-${kind}-${workspaceId}`,
            kind: "PAYMENT_SETTLED",
            occurredAt: NOW,
            checkoutContractId: opened.checkoutContractId,
            settled: money(4_900, "EUR"),
            periodEndsAt: TERM_ONE_END,
            providerReference: `sub-shared-${workspaceId}`,
          }),
          NOW,
        );
        await recordVerifiedBillingEvent(
          db(),
          verified("test-psp", {
            routeCode: "direct-eu",
            providerEventId: `shared-ref-renewed-${kind}-${workspaceId}`,
            kind: "SUBSCRIPTION_RENEWED",
            occurredAt: RENEWED_AT,
            arrangementId: opened.arrangementId,
            settled: money(4_900, "EUR"),
            periodEndsAt: TERM_TWO_END,
            // The same subscription object, as a recurring provider sends it.
            providerReference: `sub-shared-${workspaceId}`,
          }),
          RENEWED_AT,
        );

        const reversed = await recordVerifiedBillingEvent(
          db(),
          verified("test-psp", {
            routeCode: "direct-eu",
            providerEventId: `shared-ref-reversed-${kind}-${workspaceId}`,
            kind,
            occurredAt: AFTER_RENEWAL,
            arrangementId: opened.arrangementId,
            settled: money(4_900, "EUR"),
            // No period, and a reference that names the subscription rather than a charge.
            providerReference: `sub-shared-${workspaceId}`,
          }),
          AFTER_RENEWAL,
        );

        expect(reversed, kind).toMatchObject({ outcome: "APPLIED", effect: "NONE" });
        expect(await db().workspaceSubscription.findUniqueOrThrow({ where: { workspaceId }, select: { state: true, periodEndsAt: true } })).toEqual({
          state: "ACTIVE",
          periodEndsAt: TERM_TWO_END,
        });
        expect((await readEntitlement(db(), workspaceId, AFTER_RENEWAL)).paidWorkAllowed).toBe(true);
      });
    }

    it("will not let a refund of the shorter grant end the longer term a delayed renewal bought", async () => {
      // Astra's second round-three finding, and the one that invalidates "the latest event granted the
      // current term". The monotonic rule above deliberately lets a delayed renewal buy a term reaching
      // *farther* than one already applied, so ordering grants by `occurredAt` picks the wrong one.
      const { context, workspaceId } = await freshWorkspace();
      const opened = await openFor(context, request());
      await recordVerifiedBillingEvent(
        db(),
        verified("test-psp", {
          routeCode: "direct-eu",
          providerEventId: `reordered-settled-${workspaceId}`,
          kind: "PAYMENT_SETTLED",
          occurredAt: NOW,
          checkoutContractId: opened.checkoutContractId,
          settled: money(4_900, "EUR"),
          periodEndsAt: TERM_ONE_END,
        }),
        NOW,
      );
      // A: raised later, buys the shorter term.
      const shorter = await recordVerifiedBillingEvent(
        db(),
        verified("test-psp", {
          routeCode: "direct-eu",
          providerEventId: `reordered-shorter-${workspaceId}`,
          kind: "SUBSCRIPTION_RENEWED",
          occurredAt: AFTER_RENEWAL,
          arrangementId: opened.arrangementId,
          settled: money(4_900, "EUR"),
          periodEndsAt: TERM_TWO_END,
          providerReference: `charge-shorter-${workspaceId}`,
        }),
        AFTER_RENEWAL,
      );
      // B: raised earlier, arrives after, and buys the longer term — which the monotonic rule accepts.
      const longer = await recordVerifiedBillingEvent(
        db(),
        verified("test-psp", {
          routeCode: "direct-eu",
          providerEventId: `reordered-longer-${workspaceId}`,
          kind: "SUBSCRIPTION_RENEWED",
          occurredAt: RENEWED_AT,
          arrangementId: opened.arrangementId,
          settled: money(4_900, "EUR"),
          periodEndsAt: TERM_THREE_END,
          providerReference: `charge-longer-${workspaceId}`,
        }),
        RENEWED_AT,
      );
      expect([shorter.effect, longer.effect]).toEqual(["EXTEND", "EXTEND"]);
      expect(await db().workspaceSubscription.findUniqueOrThrow({ where: { workspaceId }, select: { periodEndsAt: true } })).toEqual({ periodEndsAt: TERM_THREE_END });

      // Now take back the shorter grant. It is the most recent grant by event time, and it is not the one
      // paying for the term in force.
      const reversed = await recordVerifiedBillingEvent(
        db(),
        verified("test-psp", {
          routeCode: "direct-eu",
          providerEventId: `reordered-refund-${workspaceId}`,
          kind: "REFUNDED",
          occurredAt: new Date("2026-11-03T12:00:00.000Z"),
          arrangementId: opened.arrangementId,
          settled: money(4_900, "EUR"),
          providerReference: `charge-shorter-${workspaceId}`,
        }),
        new Date("2026-11-03T12:00:00.000Z"),
      );

      expect(reversed).toMatchObject({ outcome: "APPLIED", effect: "NONE" });
      expect(await db().workspaceSubscription.findUniqueOrThrow({ where: { workspaceId }, select: { state: true, periodEndsAt: true } })).toEqual({
        state: "ACTIVE",
        periodEndsAt: TERM_THREE_END,
      });
      expect((await readEntitlement(db(), workspaceId, new Date("2026-11-03T12:00:00.000Z"))).paidWorkAllowed).toBe(true);
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

    it("will not pull a subscription cancelled at period end into grace when the last charge fails", async () => {
      // The third shape of the same hole, and the most expensive one. A cancellation leaves the
      // arrangement `ENDED` and the subscription paid through to the end of its term — the accepted
      // default. The provider then retries a charge it should no longer be making, and an unguarded
      // suspension overwrote `CANCELED_PENDING_END` with `GRACE`: that both takes away the term the
      // customer had already paid for and loses the date saying when it ends, so nothing afterwards
      // can tell what they were owed.
      const { context, workspaceId } = await freshWorkspace();
      const opened = await openFor(context, request());
      await recordVerifiedBillingEvent(
        db(),
        verified("test-psp", {
          routeCode: "direct-eu",
          providerEventId: `ended-settled-${workspaceId}`,
          kind: "PAYMENT_SETTLED",
          occurredAt: NOW,
          checkoutContractId: opened.checkoutContractId,
          settled: money(4_900, "EUR"),
        }),
        NOW,
      );
      await recordVerifiedBillingEvent(
        db(),
        verified("test-psp", {
          routeCode: "direct-eu",
          providerEventId: `ended-canceled-${workspaceId}`,
          kind: "SUBSCRIPTION_CANCELED",
          occurredAt: NOW,
          arrangementId: opened.arrangementId,
        }),
        NOW,
      );
      const cancelled = await db().workspaceSubscription.findUniqueOrThrow({
        where: { workspaceId },
        select: { state: true, periodEndsAt: true },
      });

      expect(cancelled.state).toBe("CANCELED_PENDING_END");

      const failed = await recordVerifiedBillingEvent(
        db(),
        verified("test-psp", {
          routeCode: "direct-eu",
          providerEventId: `ended-failed-${workspaceId}`,
          kind: "PAYMENT_FAILED",
          occurredAt: NOW,
          arrangementId: opened.arrangementId,
        }),
        NOW,
      );

      expect(failed).toMatchObject({ outcome: "APPLIED", effect: "NONE" });
      const after = await db().workspaceSubscription.findUniqueOrThrow({
        where: { workspaceId },
        select: { state: true, graceStartedAt: true, periodEndsAt: true },
      });
      expect(after.state).toBe("CANCELED_PENDING_END");
      expect(after.graceStartedAt).toBeNull();
      expect(after.periodEndsAt?.toISOString()).toBe(cancelled.periodEndsAt?.toISOString());
      // The whole point of cancel-at-period-end: they keep what they bought.
      expect((await readEntitlement(db(), workspaceId, NOW)).paidWorkAllowed).toBe(true);
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

  describe("the offer an acceptance is bound to", () => {
    /**
     * Astra's P1 on PR #101. The form carried the plan, the interval and the document ids, and nothing
     * identifying the *commercial* offer — so a route reconfigured between the GET that drew the ticks and
     * the POST that accepted them produced a contract naming a different selling entity, a different
     * jurisdiction and a different tax treatment than the person had been shown. A global required
     * document legitimately applies to both sellers, so the document ids cannot bind any of that.
     */
    async function displayedOffer(context: WorkspaceContext) {
      const offer = await readCheckoutOffer(db(), context, request({ supersedeCurrent: true }));
      if (!offer.available) {
        throw new Error(`offer unavailable: ${offer.reason}`);
      }
      return offer;
    }

    /** Submits exactly what a page displaying `offer` would post, and nothing else. */
    async function submit(context: WorkspaceContext, offer: Awaited<ReturnType<typeof displayedOffer>>) {
      const required = offer.documents.filter((document) => document.requiredForCheckout).map((document) => document.legalDocumentId);
      return openCheckoutContract(db(), context, {
        ...request({ supersedeCurrent: true }),
        acceptedDocumentIds: required,
        offeredDocumentIds: required,
        offeredDigest: offer.offerDigest,
      });
    }

    it("opens when the offer is still the one that was displayed", async () => {
      // The control, and the reason the refusals below mean something: posting a digest the server itself
      // produced must not stop an ordinary checkout.
      const { context } = await freshWorkspace();
      const offer = await displayedOffer(context);

      const opened = await submit(context, offer);

      expect(opened).toMatchObject({ available: true });
    });

    it("refuses when the selling entity and the tax treatment changed after the terms were displayed", async () => {
      const { context, workspaceId } = await freshWorkspace();
      const offer = await displayedOffer(context);
      expect(offer.seller.legalName, "the harness must start on the direct route").toBe("Example SRL");
      expect(offer.settlementModel).toBe("DIRECT_PSP");

      // Trusted operator configuration changes, exactly as it may at any moment: the direct route is
      // withdrawn and the Merchant-of-Record route becomes the one that admits this request.
      await db().billingRoute.update({ where: { code: "direct-eu" }, data: { enabled: false } });
      try {
        const refused = await submit(context, offer);

        expect(refused).toMatchObject({ available: false, reason: "OFFER_CHANGED" });
        // And nothing was written: no contract naming a seller nobody agreed to, and no acceptance.
        expect(await db().checkoutContract.count({ where: { workspaceId } })).toBe(0);
        expect(await db().legalAcceptance.count({ where: { workspaceId } })).toBe(0);
      } finally {
        await db().billingRoute.update({ where: { code: "direct-eu" }, data: { enabled: true } });
      }
    });

    it("refuses when the same seller's own legal identity changed after the terms were displayed", async () => {
      // The case Astra asked for by name. Nothing about the route changes here — the entity a person was
      // told they were buying from is simply not the entity now recorded, and a disclosure is the thing
      // being consented to rather than a label on it.
      const { context, workspaceId } = await freshWorkspace();
      const offer = await displayedOffer(context);

      await upsertSellerProfile(db(), {
        code: "seller-ro",
        legalName: "Example SRL (renamed)",
        displayName: "Example",
        jurisdiction: "RO",
        supportEmail: "billing@example.test",
        legalConfigRef: "config/ro",
      });
      try {
        const refused = await submit(context, offer);

        expect(refused).toMatchObject({ available: false, reason: "OFFER_CHANGED" });
        expect(await db().checkoutContract.count({ where: { workspaceId } })).toBe(0);
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

    it("refuses a seller switch when every required document is global, which is where nothing else catches it", async () => {
      // The configuration Astra's reproduction used, and it needs saying why it is a case of its own.
      // With the harness's seller-specific `PUBLIC_OFFER` required, switching sellers happens to be caught
      // by `DOCUMENT_NOT_APPLICABLE`, because the accepted offer document belongs to the other entity — so
      // that path does not demonstrate this defect at all. Make the required set global, which is a
      // legitimate configuration, and the incidental guard disappears.
      //
      // Entirely self-contained: its own sellers, its own routes in a currency nothing else uses, and its
      // own plan. An earlier version of this case dropped the requirement on the *shared* catalogue
      // instead and broke three later cases — and publications are append-only, so "restoring" it only
      // added another version and broke two more. Shared append-only state cannot be borrowed.
      const { context, workspaceId } = await freshWorkspace();
      for (const [code, legalName, jurisdiction] of [
        ["seller-digest-direct", "Digest Direct SRL", "RO"],
        ["seller-digest-mor", "Digest Reseller Inc", "US"],
      ] as const) {
        await upsertSellerProfile(db(), { code, legalName, displayName: code, jurisdiction, supportEmail: `billing@${code}.test` });
      }
      await upsertBillingRoute(db(), {
        code: "digest-direct",
        provider: "test-psp",
        providerAccountRef: "acct_digest_direct",
        sellerProfileCode: "seller-digest-direct",
        settlementModel: "DIRECT_PSP",
        capabilities: ["RECURRING_SUBSCRIPTIONS", "REFUNDS", "TAX_CALCULATION", "INVOICES", "VERIFIED_WEBHOOKS", "PRORATION"],
        currencies: ["USD"],
        intervals: ["MONTH"],
        enabled: true,
        priority: 10,
      });
      await upsertBillingRoute(db(), {
        code: "digest-mor",
        provider: "test-mor",
        providerAccountRef: "acct_digest_mor",
        sellerProfileCode: "seller-digest-mor",
        settlementModel: "MERCHANT_OF_RECORD",
        capabilities: ["RECURRING_SUBSCRIPTIONS", "REFUNDS", "TAX_CALCULATION", "TAX_REMITTANCE", "INVOICES", "VERIFIED_WEBHOOKS"],
        currencies: ["USD"],
        intervals: ["MONTH"],
        enabled: true,
        priority: 20,
      });
      const usdPlan = (
        await publishPlanVersion(db(), {
          code: "digest-binding-plan",
          name: "Digest binding plan",
          grants: { features: [], limits: {}, quotas: {} },
          prices: [{ currency: "USD", interval: "MONTH", amountCents: 4_900 }],
        })
      ).planVersionId;

      const usd = { planVersionId: usdPlan, interval: "MONTH", arrangement: "RECURRING", currency: "USD", locale: "en", at: NOW, supersedeCurrent: true } as const;
      const offer = await readCheckoutOffer(db(), context, usd);
      if (!offer.available) {
        throw new Error(`offer unavailable: ${offer.reason} ${offer.detail.join(", ")}`);
      }
      // Neither new seller has published a `PUBLIC_OFFER`, so the only required document is the global
      // terms — which is the whole point.
      expect(
        offer.documents.filter((document) => document.requiredForCheckout).map((document) => document.kind),
        "no required document may name the seller in this case",
      ).toEqual(["TERMS_OF_SERVICE"]);
      expect(offer.seller.legalName).toBe("Digest Direct SRL");
      expect(offer.settlementModel).toBe("DIRECT_PSP");

      const required = offer.documents.filter((document) => document.requiredForCheckout).map((document) => document.legalDocumentId);
      await db().billingRoute.update({ where: { code: "digest-direct" }, data: { enabled: false } });

      const refused = await openCheckoutContract(db(), context, {
        ...usd,
        acceptedDocumentIds: required,
        offeredDocumentIds: required,
        offeredDigest: offer.offerDigest,
      });

      expect(refused).toMatchObject({ available: false, reason: "OFFER_CHANGED" });
      // Nothing written: no contract naming a seller nobody agreed to, and no acceptance of its terms.
      expect(await db().checkoutContract.count({ where: { workspaceId } })).toBe(0);
      expect(await db().legalAcceptance.count({ where: { workspaceId } })).toBe(0);
    });

    it("still enforces the ticks when the offer itself has not moved", async () => {
      // The digest must not become a way around the acceptance: a submission carrying the right offer and
      // none of the ticks is still refused for what it did not accept.
      const { context } = await freshWorkspace();
      const offer = await displayedOffer(context);

      const refused = await openCheckoutContract(db(), context, {
        ...request({ supersedeCurrent: true }),
        acceptedDocumentIds: [],
        offeredDocumentIds: offer.documents.filter((document) => document.requiredForCheckout).map((document) => document.legalDocumentId),
        offeredDigest: offer.offerDigest,
      });

      expect(refused).toMatchObject({ available: false, reason: "TERMS_NOT_ACCEPTED" });
    });
  });

  describe("a language spelled two ways", () => {
    /**
     * Astra's P2 on PR #101. `legal_documents.locale` is what "which version is current in this reader's
     * language?" groups by, in TypeScript and in `current_legal_documents()`. Both grouped by the stored
     * spelling while the locale *negotiation* canonicalized before matching — so `en-US` and `en-us` were
     * two languages: each got a version 1, each stayed current, neither superseded the other, and which
     * one a reader was offered came down to row order. Publishing a replacement under the other spelling
     * therefore left the superseded text on the checkout page and let the coverage trigger accept consent
     * to it.
     *
     * Both halves of the fix need a non-canonical row to exist, and `publishLegalDocument` now refuses to
     * create one — so these write it the way the only thing that still can would: a statement run by hand,
     * or a publication from before this change. That is also what makes them regressions rather than
     * tautologies: the row they read is not one the fixed writer produced.
     *
     * Both publication orders are here because the defect's outcome was decided by neither of them.
     * `negotiateDocumentLocale` returns the *first* candidate whose canonical tag matches, and the
     * candidates arrive in `locale ASC` order — so which of two spellings a reader was offered came down
     * to the database's collation. Measured against this harness, `en-us` sorts before `en-US`, so the
     * alias-is-newer order happens to land on the right row and the alias-is-older order lands on the
     * superseded one; under a collation that sorts the other way it is the reverse. Neither case is
     * therefore sufficient alone, and both pass once the winner is computed from `effective_from` and
     * `version` instead of from row order.
     */

    /** A seller, a route, a currency and a plan nothing else in this file touches. */
    async function isolatedSeller(code: string, currency: string): Promise<string> {
      await upsertSellerProfile(db(), {
        code,
        legalName: `Alias ${code} SA`,
        displayName: "Alias",
        jurisdiction: "CH",
        supportEmail: `billing@${code}.test`,
      });
      await upsertBillingRoute(db(), {
        code: `${code}-direct`,
        provider: "test-psp",
        providerAccountRef: "acct_alias",
        sellerProfileCode: code,
        settlementModel: "DIRECT_PSP",
        capabilities: ["RECURRING_SUBSCRIPTIONS", "REFUNDS", "TAX_CALCULATION", "INVOICES", "VERIFIED_WEBHOOKS", "PRORATION"],
        currencies: [currency],
        intervals: ["MONTH"],
        enabled: true,
        priority: 90,
      });
      // Its own currency, so this seller's route is the only one that can admit the request and no other
      // case in this file can be reached by it.
      return (
        await publishPlanVersion(db(), {
          code: `${code}-plan`,
          name: "Alias",
          grants: { features: ["AI_DRAFTS"], limits: {}, quotas: {} },
          availability: "PUBLIC",
          prices: [{ currency, interval: "MONTH", amountCents: 9_900 }],
        })
      ).planVersionId;
    }

    /** A document row written verbatim, bypassing the canonicalization the store now applies. */
    async function writeRawDocument(row: {
      readonly id: string;
      readonly kind: string;
      readonly locale: string;
      readonly version: number;
      readonly sellerProfileCode: string;
      readonly effectiveFrom: string;
    }): Promise<void> {
      const written = await db().$executeRawUnsafe(
        `INSERT INTO "legal_documents"
           ("id","kind","version","locale","seller_profile_id","content_ref","required_for_checkout","effective_from","created_at")
         SELECT $1, $2::"LegalDocumentKind", $3, $4, s."id", $5, true, $6::timestamp, $6::timestamp
           FROM "seller_profiles" s WHERE s."code" = $7`,
        row.id,
        row.kind,
        row.version,
        row.locale,
        `https://legal.example.test/offer/${row.id}`,
        row.effectiveFrom,
        row.sellerProfileCode,
      );
      // A seller code that matched nothing would insert no row and every assertion below would pass
      // vacuously against a catalogue holding only the canonical version.
      expect(written, `the raw ${row.locale} row was not written`).toBe(1);
    }

    /** Everything a page would tick, with the current version of one kind swapped for a stale id. */
    const withStale = (offer: { readonly documents: readonly LegalDocumentOffer[] }, kind: string, staleId: string): readonly string[] =>
      offer.documents.filter((document) => document.requiredForCheckout).map((document) => (document.kind === kind ? staleId : document.legalDocumentId));

    it("offers one current version when the replacement was written in the other spelling", async () => {
      const planVersionId = await isolatedSeller("seller-alias-a", "CHF");
      const ask = { planVersionId, currency: "CHF", locale: "en-US" } as const;
      const superseded = await publishLegalDocument(db(), {
        kind: "PUBLIC_OFFER",
        locale: "en-US",
        contentRef: "https://legal.example.test/offer/alias-a/en-US/1",
        sellerProfileCode: "seller-alias-a",
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      });
      // The replacement, in force, spelled the way the product never spells it.
      await writeRawDocument({
        id: "raw-alias-a",
        kind: "PUBLIC_OFFER",
        locale: "en-us",
        version: 2,
        sellerProfileCode: "seller-alias-a",
        effectiveFrom: "2026-06-01T00:00:00.000Z",
      });

      const { context } = await freshWorkspace();
      const offer = await readCheckoutOffer(db(), context, request(ask), NOW);
      if (!offer.available) {
        throw new Error(`offer unavailable: ${offer.reason}`);
      }

      // One tick for this kind, not two, and it is the replacement rather than whichever spelling sorted
      // first. Before the fix this was two required documents, both version 1 of one offer.
      const offered = offer.documents.filter((document) => document.kind === "PUBLIC_OFFER");
      expect(offered.map((document) => document.legalDocumentId)).toEqual(["raw-alias-a"]);

      // And the stale id is refused once the replacement is effective — the half that matters, because a
      // reader with an open tab is holding exactly that id.
      const stale = withStale(offer, "PUBLIC_OFFER", superseded.legalDocumentId);
      const refused = await openCheckoutContract(db(), context, { ...request(ask), acceptedDocumentIds: stale, offeredDocumentIds: stale });
      expect(refused).toMatchObject({ available: false, reason: "DOCUMENT_SUPERSEDED" });
      expect(await db().checkoutContract.count({ where: { workspaceId: context.workspaceId } })).toBe(0);

      // The control, in a workspace of its own so no refused attempt can be what stopped it: accepting
      // the replacement opens the checkout. Without this a guard that refused everything would pass.
      const second = await freshWorkspace();
      const current = offer.documents.filter((document) => document.requiredForCheckout).map((document) => document.legalDocumentId);
      const opened = await openCheckoutContract(db(), second.context, { ...request(ask), acceptedDocumentIds: current, offeredDocumentIds: current });
      expect(opened).toMatchObject({ available: true });
      if (!opened.available) {
        return;
      }

      // And the database refuses the same thing on its own, which is the half the store cannot speak for.
      // `openCheckoutContract` resolves the current versions in TypeScript and returns
      // `DOCUMENT_SUPERSEDED` before any row is written, so the refusal above proves the store and says
      // nothing about `current_legal_documents()` — and that function is what the acceptance trigger
      // matches an accepted id against. With it grouping by the stored spelling, both aliases were
      // "current" and an acceptance of the superseded one was allowed straight through.
      //
      // The coverage trigger cannot catch this: it matches an acceptance to a requirement by *kind*, so
      // one acceptance of the kind satisfies it however many rows the function returned.
      await expect(
        db().$executeRawUnsafe(
          `INSERT INTO "legal_acceptances"
             ("id","workspace_id","actor_user_id","legal_document_id","checkout_contract_id","locale","accepted_at","created_at")
           VALUES ($1,$2,$3,$4,$5,'en-US',NOW(),NOW())`,
          `raw-acceptance-${opened.checkoutContractId}`,
          second.workspaceId,
          second.ownerUserId,
          superseded.legalDocumentId,
          opened.checkoutContractId,
        ),
      ).rejects.toThrow(/is superseded/u);
    });

    it("continues one version sequence across spellings, whichever spelling was published first", async () => {
      const planVersionId = await isolatedSeller("seller-alias-b", "NOK");
      const ask = { planVersionId, currency: "NOK", locale: "en-GB" } as const;
      // The other publication order: the alias is already in the catalogue when the canonical version is
      // published. `locale` sorts before `effective_from` in the query that reads these, so this is the
      // order in which "the first row of the group wins" silently returns the older document.
      await writeRawDocument({
        id: "raw-alias-b",
        kind: "PUBLIC_OFFER",
        locale: "en-gb",
        version: 1,
        sellerProfileCode: "seller-alias-b",
        effectiveFrom: "2026-01-01T00:00:00.000Z",
      });
      const replacement = await publishLegalDocument(db(), {
        kind: "PUBLIC_OFFER",
        locale: "en-GB",
        contentRef: "https://legal.example.test/offer/alias-b/en-GB/2",
        sellerProfileCode: "seller-alias-b",
        effectiveFrom: new Date("2026-06-01T00:00:00.000Z"),
      });

      // Version allocation saw the alias as the same language. A second version 1 is the state the whole
      // defect rests on: two first versions of one document, neither able to supersede the other.
      expect(replacement.version).toBe(2);

      const { context } = await freshWorkspace();
      const offer = await readCheckoutOffer(db(), context, request(ask), NOW);
      if (!offer.available) {
        throw new Error(`offer unavailable: ${offer.reason}`);
      }
      const offered = offer.documents.filter((document) => document.kind === "PUBLIC_OFFER");
      expect(offered.map((document) => document.legalDocumentId)).toEqual([replacement.legalDocumentId]);
      expect(offered.map((document) => document.version)).toEqual([2]);

      const stale = withStale(offer, "PUBLIC_OFFER", "raw-alias-b");
      const refused = await openCheckoutContract(db(), context, { ...request(ask), acceptedDocumentIds: stale, offeredDocumentIds: stale });
      expect(refused).toMatchObject({ available: false, reason: "DOCUMENT_SUPERSEDED" });
    });

    it("refuses to store a spelling the database cannot group, and refuses to publish one at all", async () => {
      // The two halves of the backstop. `publishLegalDocument` canonicalizes everything it can name a
      // language for and refuses what it cannot; the CHECK refuses the separator form that no canonical
      // tag has, so a hand-run statement cannot leave `ru_RU` in a column that is also displayed to a
      // reader as the language a contract is published in.
      await expect(
        publishLegalDocument(db(), {
          kind: "REFUND_POLICY",
          locale: "nonsense tag",
          contentRef: "https://legal.example.test/refunds/x/1",
          effectiveFrom: NOW,
        }),
      ).rejects.toThrow(DbInputError);

      const stored = await publishLegalDocument(db(), {
        kind: "REFUND_POLICY",
        locale: "RU-ru",
        contentRef: "https://legal.example.test/refunds/ru/1",
        requiredForCheckout: false,
        effectiveFrom: NOW,
      });
      const row = await db().legalDocument.findUniqueOrThrow({ where: { id: stored.legalDocumentId }, select: { locale: true } });
      expect(row.locale).toBe("ru-RU");

      await expect(
        db().$executeRawUnsafe(
          `INSERT INTO "legal_documents" ("id","kind","version","locale","content_ref","required_for_checkout","effective_from","created_at")
           VALUES ('raw-underscore','REFUND_POLICY'::"LegalDocumentKind",99,'ru_RU','https://legal.example.test/refunds/raw',false,NOW(),NOW())`,
        ),
      ).rejects.toThrow(/legal_documents_locale_well_formed/u);

      // And the state the whole defect rested on is now unreachable: two rows of one kind and one
      // language sharing a version number. The declared unique is on the stored spelling, so `RU-ru` v1
      // and `ru-RU` v1 satisfied it and neither could supersede the other.
      await expect(
        db().$executeRawUnsafe(
          `INSERT INTO "legal_documents" ("id","kind","version","locale","content_ref","required_for_checkout","effective_from","created_at")
           VALUES ('raw-alias-version','REFUND_POLICY'::"LegalDocumentKind",$1,'RU-ru','https://legal.example.test/refunds/alias',false,NOW(),NOW())`,
          stored.version,
        ),
      ).rejects.toThrow(/legal_documents_kind_language_version_key/u);
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

  describe("the accepted tiers", () => {
    it("each reach ACTIVE through a verified event, carrying the capacity the accepted table publishes", async () => {
      // #44 asks for Starter/Growth/Scale activation against immutable accepted plan versions, and every
      // other case in this file buys a plan this file published for itself. That is the gap: a tier can be
      // in the accepted catalogue, priced, and still not be buyable — twice already something was
      // published here that nothing could use (the provider price ids no checkout could read, and the
      // add-ons no path can name). So this buys all three from the catalogue a deployment actually
      // publishes, through the same checkout and the same verified settlement as a customer.
      const catalog = await publishAcceptedCatalog(db());

      for (const tier of ACCEPTED_PLANS) {
        const { context, workspaceId } = await freshWorkspace();
        const planVersionId = catalog.plans.find((plan) => plan.code === tier.code)?.planVersionId;
        expect(planVersionId, tier.code).toBeDefined();

        const opened = await openFor(context, request({ planVersionId }));
        // The amount is the tier's own published monthly price. A settlement for the wrong figure is
        // judged against the quote and would come back `NONE`, so this also says the price the catalogue
        // published is the price a charge can settle against.
        expect(opened.base, tier.code).toEqual(money(tier.monthlyCents, "EUR"));

        const settled = await recordVerifiedBillingEvent(
          db(),
          verified("test-psp", {
            routeCode: "direct-eu",
            providerEventId: `accepted-${tier.code}-${workspaceId}`,
            kind: "PAYMENT_SETTLED",
            occurredAt: NOW,
            checkoutContractId: opened.checkoutContractId,
            settled: money(tier.monthlyCents, "EUR"),
            providerReference: `sub_${tier.code}_${workspaceId}`,
          }),
          NOW,
        );

        expect(settled, tier.code).toMatchObject({ outcome: "APPLIED", effect: "ACTIVATE" });

        // What the customer bought, read back through the entitlement every gate consults. The numbers are
        // the accepted table's own, taken from the constant rather than retyped, so this says the
        // published version carries them end to end rather than restating the table a third time.
        const entitlement = await readEntitlement(db(), workspaceId, NOW);
        expect(entitlement, tier.code).toMatchObject({ state: "ACTIVE", planCode: tier.code, paidWorkAllowed: true, subscribed: true });
        expect(entitlement.limits, tier.code).toEqual({
          BUSINESS_PROFILES: tier.businessProfiles,
          SEATS: tier.seats,
          ANALYTICS_RETENTION_DAYS: tier.analyticsRetentionDays,
        });
        expect(entitlement.quotas["VOICE_TRANSCRIPTION_SECONDS"], tier.code).toBe(tier.voiceMinutes * 60);
      }
    });

    it("prices the annual term from the accepted book rather than deriving it", async () => {
      // "Pay ten months, receive twelve" is stated outright in the catalogue and the spec, and a product
      // that recomputed it would be free to disagree with an invoice a customer already holds. Asserted
      // through a real checkout because the annual price is the one a test plan never exercises.
      const catalog = await publishAcceptedCatalog(db());
      const growth = ACCEPTED_PLANS.find((plan) => plan.code === "growth");
      const planVersionId = catalog.plans.find((plan) => plan.code === "growth")?.planVersionId;
      const { context } = await freshWorkspace();

      const opened = await openFor(context, request({ planVersionId, interval: "YEAR" }));

      expect(opened.base).toEqual(money(growth?.annualCents ?? 0, "EUR"));
      expect(growth?.annualCents).toBe((growth?.monthlyCents ?? 0) * 10);
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
