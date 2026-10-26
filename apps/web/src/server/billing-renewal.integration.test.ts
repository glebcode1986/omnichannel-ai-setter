/**
 * Telling the provider to stop renewing, and what happens when it cannot be told (#41).
 *
 * The decision being tested is the product owner's: **best-effort**. A customer's cancellation is already
 * committed before any of this runs, so nothing here may fail it — and the only question left is whether
 * what happened to the request is discoverable afterwards. Every case therefore ends by reading the audit
 * trail, because that record is the difference between a cancellation that takes effect by itself and one
 * somebody has to act on before the next charge.
 *
 * The arrangement is made the way production makes one: a published catalogue, a seller profile, an
 * enabled route, a committed checkout contract and a verified settlement. A hand-written
 * `billing_arrangements` row would have let the reader under test pass against a shape nothing produces.
 */
import {
  publishAcceptedCatalog,
  publishLegalDocument,
  readRenewalTarget,
  recordVerifiedBillingEvent,
  registerBillingProvider,
  clearBillingProviders,
  openCheckoutContract,
  readCheckoutOffer,
  searchAuditEvents,
  setWorkspaceSubscription,
  upsertBillingRoute,
  upsertSellerProfile,
  verifyProviderDelivery,
  type PublishedCatalog,
} from "@omnichannel/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { stopRenewingBestEffort } from "./billing-renewal";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { createPaidWorkspace } from "./testing/paid-workspace";

const ROUTE_CODE = "renewal-route";
const PROVIDER = "test-renewal-psp";
const PRICE_REF = "price_growth_eur_month";
const NOW = new Date("2026-10-13T12:00:00.000Z");

describe.skipIf(!databaseTestsEnabled())("asking the provider to stop renewing", () => {
  let database: TestDatabase;
  let catalog: PublishedCatalog;
  let growthPlanVersionId: string;
  let sequence = 0;
  /** What the stub adapter should do when asked; replaced per case. */
  let renewal: (() => Promise<{ renews: boolean }>) | undefined;
  /** What it was asked — the request is half of what this file is about, so it is captured, not ignored. */
  let asked: { readonly routeCode: string; readonly providerReference: string; readonly renew: boolean }[] = [];

  const db = () => database.db;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    catalog = await publishAcceptedCatalog(db(), { growth: { MONTH: PRICE_REF } });
    growthPlanVersionId = catalog.plans.find((entry) => entry.code === "growth")?.planVersionId ?? "";

    await upsertSellerProfile(db(), {
      code: "renewal-seller",
      legalName: "Renewal Seller",
      displayName: "Renewal",
      jurisdiction: "UA",
      supportEmail: "billing@example.test",
    });
    await upsertBillingRoute(db(), {
      code: ROUTE_CODE,
      provider: PROVIDER,
      sellerProfileCode: "renewal-seller",
      settlementModel: "DIRECT_PSP",
      capabilities: ["RECURRING_SUBSCRIPTIONS", "VERIFIED_WEBHOOKS"],
      currencies: ["EUR"],
      intervals: ["MONTH", "YEAR"],
      enabled: true,
    });
    for (const [kind, ref] of [
      ["TERMS_OF_SERVICE", "terms"],
      ["PUBLIC_OFFER", "offer"],
    ] as const) {
      await publishLegalDocument(db(), {
        kind,
        locale: "en",
        contentRef: `https://legal.example.test/${ref}/en/1`,
        ...(kind === "PUBLIC_OFFER" ? { sellerProfileCode: "renewal-seller" } : {}),
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      });
    }
  }, 300_000);

  afterAll(async () => {
    clearBillingProviders();
    await database?.dispose();
  });

  beforeEach(() => {
    renewal = undefined;
    asked = [];
    clearBillingProviders();
  });

  /** Registers the stub with, or without, the capability under test. */
  const register = (withRenewal: boolean) => {
    registerBillingProvider({
      provider: PROVIDER,
      // A real adapter parses a payload and hands back `Date` objects; this one used to hand back the
      // strings `JSON.parse` produced, and `as never` hid it. The port refuses that now, so the fixture
      // tells the truth instead of being excused by a cast.
      verify: (delivery: { readonly body: string }) => {
        const payload = JSON.parse(delivery.body) as { readonly occurredAt: string } & Record<string, unknown>;
        return { kind: "EVENT", event: { ...payload, occurredAt: new Date(payload.occurredAt) } as never };
      },
      ...(withRenewal
        ? {
            setRenewal: async (request: { readonly routeCode: string; readonly providerReference: string; readonly renew: boolean }) => {
              asked.push(request);
              if (renewal === undefined) {
                throw new Error("the fixture did not say what the provider should answer");
              }
              return renewal();
            },
          }
        : {}),
    } as never);
  };

  /** A workspace with an ACTIVE arrangement carrying a provider reference, through the production path. */
  const settledWorkspace = async () => {
    sequence += 1;
    const made = await createPaidWorkspace(db(), `renewal-${String(sequence)}`);
    await setWorkspaceSubscription(db(), made.owner, { planVersionId: growthPlanVersionId, state: "ACTIVE" });
    const offer = await readCheckoutOffer(db(), made.owner, {
      planVersionId: growthPlanVersionId,
      interval: "MONTH",
      arrangement: "RECURRING",
      currency: "EUR",
      locale: "en",
    });
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
      // The digest of the offer this fixture was actually shown. Required since #103: a submission that
      // does not carry it is a submission against an offer nobody displayed.
      offeredDigest: offer.offerDigest,
    });
    if (!opened.available) {
      throw new Error(`the fixture could not open a checkout: ${opened.reason}`);
    }
    const body = JSON.stringify({
      routeCode: ROUTE_CODE,
      providerEventId: `settled-${String(sequence)}`,
      kind: "PAYMENT_SETTLED",
      occurredAt: NOW.toISOString(),
      checkoutContractId: opened.checkoutContractId,
      settled: { amountMinor: 9_900, currency: "EUR" },
      providerReference: `sub_${String(sequence)}`,
    });
    const minted = await verifyProviderDelivery({ provider: PROVIDER, body, headers: {}, receivedAt: NOW });
    if (minted.kind !== "EVENT") {
      throw new Error(`the stub adapter answered ${minted.kind} to its own delivery`);
    }
    const applied = await recordVerifiedBillingEvent(db(), minted.event, NOW);
    if (applied.outcome !== "APPLIED") {
      throw new Error(`the fixture could not settle the checkout: ${applied.outcome}`);
    }
    return made;
  };

  const auditSummaries = async (owner: Parameters<typeof searchAuditEvents>[1]) =>
    (await searchAuditEvents(db(), owner, { kinds: ["BILLING_ARRANGEMENT_CHANGED"] })).rows.map((row) => row.summary);

  it("asks the provider and records what it answered", async () => {
    register(true);
    const made = await settledWorkspace();
    renewal = () => Promise.resolve({ renews: false });

    await stopRenewingBestEffort({ db: db(), context: made.owner, workspaceId: made.workspaceId, ensureAdapters: () => undefined });

    // What it was asked matters as much as what it answered: `renew: true` here would tell the provider to
    // keep charging a customer who cancelled, and a stub that ignored the request could not tell us.
    expect(asked).toEqual([{ routeCode: ROUTE_CODE, providerReference: `sub_${String(sequence)}`, renew: false }]);
    expect(await auditSummaries(made.owner)).toContainEqual(
      expect.stringContaining(`Asked the provider to stop renewing on route ${ROUTE_CODE}; it reports renews=false`),
    );
  }, 300_000);

  it("records a provider failure instead of raising it", async () => {
    register(true);
    const made = await settledWorkspace();
    renewal = () => Promise.reject(new TypeError("sk_live_abcdefghijklmnop is unreachable"));

    // Must not throw: the cancellation is already committed and the customer already told.
    await expect(
      stopRenewingBestEffort({ db: db(), context: made.owner, workspaceId: made.workspaceId, ensureAdapters: () => undefined }),
    ).resolves.toBeUndefined();

    const summaries = await auditSummaries(made.owner);
    expect(summaries).toContainEqual(expect.stringContaining("failed on route"));
    expect(summaries).toContainEqual(expect.stringContaining("the cancellation stands locally and the provider may charge again"));
    // The error's name, never its message: a provider's text can carry a key or a reference.
    expect(summaries.join("\n")).toContain("TypeError");
    expect(summaries.join("\n")).not.toContain("sk_live_");
  }, 300_000);

  it("says the provider was never asked when it cannot be", async () => {
    register(false);
    const made = await settledWorkspace();

    await stopRenewingBestEffort({ db: db(), context: made.owner, workspaceId: made.workspaceId, ensureAdapters: () => undefined });

    expect(asked).toEqual([]);
    expect(await auditSummaries(made.owner)).toContainEqual(
      expect.stringContaining("This provider cannot be asked to stop renewing"),
    );
  }, 300_000);

  it("says so when there is no arrangement to stop", async () => {
    register(true);
    sequence += 1;
    const made = await createPaidWorkspace(db(), `renewal-none-${String(sequence)}`);

    await stopRenewingBestEffort({ db: db(), context: made.owner, workspaceId: made.workspaceId, ensureAdapters: () => undefined });

    expect(await auditSummaries(made.owner)).toContainEqual(
      expect.stringContaining("No active provider arrangement to stop renewing"),
    );
  }, 300_000);

  it("reads the target from the arrangement the settlement produced", async () => {
    register(true);
    const made = await settledWorkspace();

    const target = await readRenewalTarget(db(), made.workspaceId);

    // The provider's own handle comes from the verified event, not from anything a client could name.
    expect(target).toEqual({ provider: PROVIDER, routeCode: ROUTE_CODE, providerReference: `sub_${String(sequence)}` });
  }, 300_000);

  it("finds no target for a workspace that never settled anything", async () => {
    sequence += 1;
    const made = await createPaidWorkspace(db(), `renewal-unsettled-${String(sequence)}`);

    // A renewal request naming no object is one the provider cannot answer, and guessing a reference is
    // how a request ends up changing somebody else's subscription.
    expect(await readRenewalTarget(db(), made.workspaceId)).toBeNull();
  }, 300_000);
});
