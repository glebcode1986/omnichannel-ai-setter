/**
 * Handing a customer to Stripe, from a committed contract, against a real database (Issue #41).
 *
 * The seam this proves is the one a unit test cannot: **everything the provider is told is read back from
 * the contract, not from the request.** The route, the seller, the arrangement kind, the amount and the
 * price all come out of the row that was written when the terms were accepted — so there is no parameter
 * in which a client could name a cheaper price or point one seller's checkout at another seller's Stripe
 * account, which is what ADR-019 forbids.
 *
 * The real adapter is registered, with a scripted transport: no network, no key and no charge.
 */
import {
  attachProviderCheckoutReference,
  clearBillingProviders,
  openCheckoutContract,
  publishAcceptedCatalog,
  publishLegalDocument,
  publishPlanVersion,
  readCheckoutOffer,
  registerBillingProvider,
  setWorkspaceSubscription,
  upsertBillingRoute,
  upsertSellerProfile,
  type PublishedCatalog,
} from "@omnichannel/db";
import { createStripeBillingAdapter, STRIPE_PROVIDER, type BillingHttpRequest, type BillingHttpResult } from "@omnichannel/billing-stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { createPaidWorkspace } from "./testing/paid-workspace";
import { requestProviderCheckout } from "./provider-checkout";

const ROUTE_CODE = "stripe-handoff";
const PRICE_REF = "price_growth_eur_month";
const RETURN_BASE = "https://app.example.test";
const RETURN_PATH = "/workspaces/ws/profiles/bp/settings/billing";
const NOW = new Date("2026-10-12T12:00:00.000Z");

const logged: { level: string; event: string; fields: Readonly<Record<string, unknown>> }[] = [];
const logger = () => {
  const record = (level: string) => (event: string, fields: Readonly<Record<string, unknown>> = {}) => {
    logged.push({ level, event, fields });
  };
  return { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") } as never;
};

describe.skipIf(!databaseTestsEnabled())("handing a committed checkout to Stripe", () => {
  let database: TestDatabase;
  let catalog: PublishedCatalog;
  let growthPlanVersionId: string;
  let sent: BillingHttpRequest[] = [];
  let answers: BillingHttpResult[] = [];
  let sequence = 0;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    // The provider price is given at publication, because it can only be given then: catalogue prices
    // are immutable, and a trigger refuses the `UPDATE` that would add one afterwards.
    catalog = await publishAcceptedCatalog(database.db, { growth: { MONTH: PRICE_REF } });
    growthPlanVersionId = catalog.plans.find((entry) => entry.code === "growth")?.planVersionId ?? "";

    await upsertSellerProfile(database.db, {
      code: "ua-fop",
      legalName: "Example FOP",
      displayName: "Example",
      jurisdiction: "UA",
      supportEmail: "billing@example.test",
    });
    await upsertBillingRoute(database.db, {
      code: ROUTE_CODE,
      provider: STRIPE_PROVIDER,
      sellerProfileCode: "ua-fop",
      settlementModel: "DIRECT_PSP",
      capabilities: ["RECURRING_SUBSCRIPTIONS", "VERIFIED_WEBHOOKS", "CUSTOMER_PORTAL", "AUTHORITATIVE_RECONCILIATION"],
      currencies: ["EUR"],
      intervals: ["MONTH", "YEAR"],
      enabled: true,
    });
    for (const [kind, ref] of [
      ["TERMS_OF_SERVICE", "terms"],
      ["PUBLIC_OFFER", "offer"],
    ] as const) {
      await publishLegalDocument(database.db, {
        kind,
        locale: "en",
        contentRef: `https://legal.example.test/${ref}/en/1`,
        ...(kind === "PUBLIC_OFFER" ? { sellerProfileCode: "ua-fop" } : {}),
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      });
    }

    registerBillingProvider(
      createStripeBillingAdapter({
        routes: [{ routeCode: ROUTE_CODE, secretKey: "rk_test_handoff", webhookSecrets: ["whsec_handoff"] }],
        http: {
          send(request) {
            sent.push(request);
            const answer = answers.shift();
            return Promise.resolve(answer ?? { kind: "RESPONSE", status: 200, body: JSON.stringify({ id: "cs_test_default", url: "https://checkout.stripe.com/c/pay/cs_test_default" }) });
          },
        },
        now: () => NOW,
      }),
    );
  }, 300_000);

  afterAll(async () => {
    clearBillingProviders();
    await database?.dispose();
  });

  beforeEach(() => {
    sent = [];
    answers = [];
    logged.length = 0;
  });

  const db = () => database.db;

  /** A committed contract, through the production path: acceptance snapshot and all. */
  const contract = async () => {
    sequence += 1;
    const made = await createPaidWorkspace(db(), `handoff-${String(sequence)}`);
    await setWorkspaceSubscription(db(), made.owner, { planVersionId: growthPlanVersionId, state: "ACTIVE" });
    const offer = await readCheckoutOffer(db(), made.owner, { planVersionId: growthPlanVersionId, interval: "MONTH", arrangement: "RECURRING", currency: "EUR", locale: "en" });
    if (!offer.available) {
      throw new Error(`the fixture could not offer a checkout: ${offer.reason}`);
    }
    const opened = await openCheckoutContract(db(), made.owner, {
      planVersionId: growthPlanVersionId,
      interval: "MONTH",
      arrangement: "RECURRING",
      currency: "EUR",
      locale: "en",
      acceptedDocumentIds: offer.documents.filter((document) => document.requiredForCheckout).map((document) => document.legalDocumentId),
      offeredDocumentIds: offer.documents.map((document) => document.legalDocumentId),
    });
    if (!opened.available) {
      throw new Error(`the fixture could not open a checkout: ${opened.reason}`);
    }
    return opened;
  };

  /**
   * Deliberately no default for `returnBaseUrl`: a default parameter is applied when `undefined` is
   * passed explicitly, so a case meaning "nothing is configured" would silently get the configured value
   * and pass for the wrong reason.
   */
  const handOff = async (checkoutContractId: string, options: { readonly returnBaseUrl: string | undefined } = { returnBaseUrl: RETURN_BASE }) =>
    requestProviderCheckout({
      db: db(),
      logger: logger(),
      checkoutContractId,
      returnBaseUrl: options.returnBaseUrl,
      returnPath: RETURN_PATH,
      ensureAdapters: () => undefined,
    });

  it("sends the route, the price and the amount the contract fixed, and nothing a caller supplied", async () => {
    const opened = await contract();
    answers.push({ kind: "RESPONSE", status: 200, body: JSON.stringify({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" }) });

    const handoff = await handOff(opened.checkoutContractId);

    expect(handoff).toEqual({ kind: "REDIRECT", url: "https://checkout.stripe.com/c/pay/cs_test_1", reference: "cs_test_1" });
    const fields = new URLSearchParams(sent[0]?.body ?? "");
    // The price from the catalogue row the contract's own plan version, interval and base currency name.
    expect(fields.get("line_items[0][price]")).toBe(PRICE_REF);
    expect(fields.get("mode")).toBe("subscription");
    // The contract id, which is what comes back on the settlement.
    expect(fields.get("client_reference_id")).toBe(opened.checkoutContractId);
    // And the key that makes a double-click return the first session rather than opening a second.
    expect(sent[0]?.headers["idempotency-key"]).toBe(`checkout:${opened.checkoutContractId}`);
    // The return URLs are built from the configured origin, so neither is a page somebody else owns.
    expect(fields.get("success_url")).toBe(`${RETURN_BASE}${RETURN_PATH}?outcome=CHECKOUT_RETURNED`);
    expect(fields.get("cancel_url")).toBe(`${RETURN_BASE}${RETURN_PATH}?outcome=CHECKOUT_ABANDONED`);
  }, 180_000);

  it("records the provider's session against the contract, once", async () => {
    const opened = await contract();
    answers.push({ kind: "RESPONSE", status: 200, body: JSON.stringify({ id: "cs_test_2", url: "https://checkout.stripe.com/c/pay/cs_test_2" }) });

    await handOff(opened.checkoutContractId);

    const stored = await db().checkoutContract.findUnique({ where: { id: opened.checkoutContractId }, select: { providerCheckoutRef: true } });
    expect(stored?.providerCheckoutRef).toBe("cs_test_2");
    // Write-once, in the function and again in a trigger: a second reference would mean a second session,
    // and a settlement granted against one of them could not be matched to the other.
    await expect(attachProviderCheckoutReference(db(), opened.checkoutContractId, "cs_test_someone_else")).rejects.toThrow();
    // The same value again is not a second session, so it is accepted and changes nothing.
    await attachProviderCheckoutReference(db(), opened.checkoutContractId, "cs_test_2");
    expect((await db().checkoutContract.findUnique({ where: { id: opened.checkoutContractId }, select: { providerCheckoutRef: true } }))?.providerCheckoutRef).toBe(
      "cs_test_2",
    );
  }, 180_000);

  it("offers no hand-off when there is nowhere to come back to", async () => {
    const opened = await contract();

    expect(await handOff(opened.checkoutContractId, { returnBaseUrl: undefined })).toBeUndefined();
    // Nothing was asked of Stripe, so no session exists to be paid for and then lost.
    expect(sent).toHaveLength(0);
    expect(logged.map((entry) => entry.event)).toContain("billing.checkout_handoff_unconfigured");
  }, 180_000);

  it("offers no hand-off when the catalogue has no provider price for the plan", async () => {
    // A plan version published without a provider price, which is what a deployment that has not mapped
    // its Stripe prices has. Published as its own version rather than edited, because catalogue prices
    // are immutable — which is also why the map has to be given at publication.
    const unmapped = await publishPlanVersion(db(), {
      code: "unmapped-plan",
      name: "Unmapped",
      availability: "PUBLIC",
      grants: { features: ["AI_DRAFTS"], limits: { BUSINESS_PROFILES: 1 }, quotas: {} },
      prices: [{ currency: "EUR", interval: "MONTH", amountCents: 4_900 }],
    });
    const made = await createPaidWorkspace(db(), `handoff-unpriced-${String(Date.now())}`);
    await setWorkspaceSubscription(db(), made.owner, { planVersionId: unmapped.planVersionId, state: "ACTIVE" });
    const offer = await readCheckoutOffer(db(), made.owner, {
      planVersionId: unmapped.planVersionId,
      interval: "MONTH",
      arrangement: "RECURRING",
      currency: "EUR",
      locale: "en",
    });
    if (!offer.available) {
      throw new Error(`the fixture could not offer a checkout: ${offer.reason}`);
    }
    const opened = await openCheckoutContract(db(), made.owner, {
      planVersionId: unmapped.planVersionId,
      interval: "MONTH",
      arrangement: "RECURRING",
      currency: "EUR",
      locale: "en",
      acceptedDocumentIds: offer.documents.filter((document) => document.requiredForCheckout).map((document) => document.legalDocumentId),
      offeredDocumentIds: offer.documents.map((document) => document.legalDocumentId),
    });
    if (!opened.available) {
      throw new Error(`the fixture could not open a checkout: ${opened.reason}`);
    }

    expect(await handOff(opened.checkoutContractId)).toBeUndefined();
    // A session priced by a default would charge a number nobody published.
    expect(sent).toHaveLength(0);
    expect(logged.map((entry) => entry.event)).toContain("billing.checkout_handoff_unpriced");
  }, 180_000);

  it("offers no hand-off for a contract that does not exist", async () => {
    expect(await handOff("00000000-0000-7000-8000-000000000000")).toBeUndefined();
    expect(sent).toHaveLength(0);
  }, 180_000);

  it("propagates a provider failure rather than reporting a hand-off that did not happen", async () => {
    const opened = await contract();
    answers.push({ kind: "NO_RESPONSE", reason: "TIMEOUT" });

    await expect(handOff(opened.checkoutContractId)).rejects.toMatchObject({ kind: "TIMEOUT" });
    // And the contract carries no session reference, so pressing the button again opens one against the
    // same contract rather than being refused as already handed off.
    const stored = await db().checkoutContract.findUnique({ where: { id: opened.checkoutContractId }, select: { providerCheckoutRef: true } });
    expect(stored?.providerCheckoutRef).toBeNull();
  }, 180_000);

  it("writes down the route it used and nothing about the money or the customer", async () => {
    const opened = await contract();
    answers.push({ kind: "RESPONSE", status: 200, body: JSON.stringify({ id: "cs_test_3", url: "https://checkout.stripe.com/c/pay/cs_test_3" }) });

    await handOff(opened.checkoutContractId);

    expect(logged).toContainEqual({ level: "info", event: "billing.checkout_handoff_opened", fields: { routeCode: ROUTE_CODE, handoff: "REDIRECT" } });
    const everything = JSON.stringify(logged);
    expect(everything).not.toContain("rk_test_handoff");
    expect(everything).not.toContain(PRICE_REF);
    expect(everything).not.toContain(opened.checkoutContractId);
  }, 180_000);
});
