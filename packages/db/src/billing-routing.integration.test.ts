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
      contentRef: "terms/en/1",
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    });
    await publishLegalDocument(database.db, {
      kind: "PUBLIC_OFFER",
      locale: "en",
      contentRef: "offer/ro/en/1",
      sellerProfileCode: "seller-ro",
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    });
    await publishLegalDocument(database.db, {
      kind: "PUBLIC_OFFER",
      locale: "en",
      contentRef: "offer/mor/en/1",
      sellerProfileCode: "seller-mor",
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    });
    // Published and not yet in force. Nothing should offer it or accept it.
    await publishLegalDocument(database.db, {
      kind: "PRIVACY_POLICY",
      locale: "en",
      contentRef: "privacy/en/next",
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

    it("still revokes when the reversal is of the payment that bought the term in force", async () => {
      // The positive control, and the reason the two cases above are not simply "reversals do nothing".
      // Without it, deleting the whole attribution check and returning `NONE` for every reversal would
      // pass them both.
      const { workspaceId, opened } = await twoPaidTerms("same-arr-current");

      const reversed = await recordVerifiedBillingEvent(
        db(),
        verified("test-psp", {
          routeCode: "direct-eu",
          providerEventId: `same-arr-current-${workspaceId}`,
          kind: "REFUNDED",
          occurredAt: RENEWED_AT,
          arrangementId: opened.arrangementId,
          settled: money(4_900, "EUR"),
          periodEndsAt: TERM_TWO_END,
        }),
        AFTER_RENEWAL,
      );

      expect(reversed).toMatchObject({ outcome: "APPLIED", effect: "END" });
      expect(await db().workspaceSubscription.findUniqueOrThrow({ where: { workspaceId }, select: { state: true } })).toEqual({ state: "INACTIVE" });
      expect(await db().billingArrangement.findUniqueOrThrow({ where: { id: opened.arrangementId }, select: { state: true } })).toEqual({ state: "ENDED" });
      expect((await readEntitlement(db(), workspaceId, AFTER_RENEWAL)).paidWorkAllowed).toBe(false);
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

  describe("the acceptance snapshot", () => {
    it("offers the seller's own public offer and nothing that is not yet in force", async () => {
      const { context } = await freshWorkspace();
      const offer = await readCheckoutOffer(db(), context, request());

      expect(offer.available).toBe(true);
      if (offer.available) {
        expect(offer.documents.map((document) => document.kind).sort()).toEqual(["PUBLIC_OFFER", "TERMS_OF_SERVICE"]);
        expect(offer.documents.find((document) => document.kind === "PUBLIC_OFFER")?.contentRef).toBe("offer/ro/en/1");
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
        where: { contentRef: "offer/mor/en/1" },
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
      const published = await db().legalDocument.findFirstOrThrow({ where: { contentRef: "terms/en/1" }, select: { id: true } });

      await expect(db().$executeRawUnsafe(`UPDATE "legal_documents" SET "content_ref" = 'terms/en/1-edited' WHERE "id" = '${published.id}'`)).rejects.toThrow(
        /legal_documents are immutable/u,
      );
    });

    it("assigns the next version per kind and locale", async () => {
      const second = await publishLegalDocument(db(), {
        kind: "TERMS_OF_SERVICE",
        locale: "en",
        contentRef: "terms/en/2",
        effectiveFrom: new Date("2026-02-01T00:00:00.000Z"),
      });
      const other = await publishLegalDocument(db(), {
        kind: "TERMS_OF_SERVICE",
        locale: "ru",
        contentRef: "terms/ru/1",
        effectiveFrom: new Date("2026-02-01T00:00:00.000Z"),
      });

      expect(second.version).toBe(2);
      expect(other.version).toBe(1);
      // And the newer English version is what a checkout is offered against from now on.
      const { context } = await freshWorkspace();
      const offer = await readCheckoutOffer(db(), context, request());
      if (offer.available) {
        expect(offer.documents.find((document) => document.kind === "TERMS_OF_SERVICE")).toMatchObject({ version: 2, contentRef: "terms/en/2" });
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
      const document = await db().legalDocument.findFirstOrThrow({ where: { contentRef: "terms/en/1" }, select: { id: true } });

      await expect(
        db().$executeRawUnsafe(
          `INSERT INTO "legal_acceptances" ("id","workspace_id","actor_user_id","legal_document_id","checkout_contract_id","accepted_at")
           VALUES ('cross-tenant-acceptance','${second.workspaceId}','${second.ownerUserId}','${document.id}','${opened.checkoutContractId}',NOW())`,
        ),
      ).rejects.toThrow(/belongs to the workspace whose checkout/u);
    });
  });

});
