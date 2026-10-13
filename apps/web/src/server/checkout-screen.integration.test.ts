/**
 * The acceptance step, against a real database (#47, ADR-019).
 *
 * The pane tests prove what is rendered. This proves what is *enforced*, which no pane test can: that a
 * submission with a box unticked is refused, that an admin gets a page rather than a thrown error, and
 * that a reader whose language the offer has not been translated into is still shown something to accept.
 *
 * It drives `assembleCheckoutScreen` and `openCheckoutContract` rather than reissuing their reads, for
 * the reason the Style screen learned: a helper that rebuilt the loader's queries would pass against a
 * loader that had stopped making one of them.
 *
 * A provider adapter is registered here, and that matters. Without one every checkout is refused
 * `PROVIDER_UNAVAILABLE` before the terms are ever examined, so a suite that skipped this step would be
 * green while asserting nothing about acceptance — and would stay green with the enforcement deleted.
 */
import {
  clearBillingProviders,
  openCheckoutContract,
  publishLegalDocument,
  registerBillingProvider,
  setWorkspaceSubscription,
  upsertBillingRoute,
  upsertSellerProfile,
  type PublishedCatalog,
} from "@omnichannel/db";
import { publishAcceptedCatalog } from "@omnichannel/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { acceptedDocumentIdsFrom, offeredDocumentIdsFrom } from "./checkout-form";
import { assembleCheckoutScreen, CHECKOUT_REFUSAL_MESSAGES } from "./checkout-screen";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { createPaidWorkspace } from "./testing/paid-workspace";
import { catalogues } from "@/i18n/catalogue";
import { CHECKOUT_REFUSALS } from "@omnichannel/db";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const BASE = "/workspaces/ws/profiles/bp/settings/billing/checkout";
const PROVIDER = "web-test-psp";

describe.skipIf(!databaseTestsEnabled())("the checkout acceptance step", () => {
  let database: TestDatabase;
  let catalog: PublishedCatalog;
  let growthPlanVersionId: string;
  let sequence = 0;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    catalog = await publishAcceptedCatalog(database.db);
    growthPlanVersionId = catalog.plans.find((entry) => entry.code === "growth")?.planVersionId ?? "";

    await upsertSellerProfile(database.db, {
      code: "web-seller",
      legalName: "Web Example SRL",
      displayName: "Web Example",
      jurisdiction: "RO",
      supportEmail: "billing@web.example.test",
    });
    await upsertBillingRoute(database.db, {
      code: "web-direct",
      provider: PROVIDER,
      sellerProfileCode: "web-seller",
      settlementModel: "DIRECT_PSP",
      capabilities: ["RECURRING_SUBSCRIPTIONS", "VERIFIED_WEBHOOKS"],
      currencies: ["EUR"],
      intervals: ["MONTH", "YEAR"],
      enabled: true,
    });
    await publishLegalDocument(database.db, {
      kind: "TERMS_OF_SERVICE",
      locale: "en",
      contentRef: "https://legal.web.example.test/terms/en/1",
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    });
    await publishLegalDocument(database.db, {
      kind: "PUBLIC_OFFER",
      locale: "en",
      contentRef: "https://legal.web.example.test/offer/en/1",
      sellerProfileCode: "web-seller",
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    });
    await publishLegalDocument(database.db, {
      kind: "REFUND_POLICY",
      locale: "en",
      contentRef: "https://legal.web.example.test/refunds/en/1",
      requiredForCheckout: false,
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    });

    // The adapter the whole path needs. Its `verify` is never called here — this suite is about the
    // acceptance step — but its presence is what makes `checkoutReady` true.
    registerBillingProvider({ provider: PROVIDER, verify: () => null });
  }, 300_000);

  afterAll(async () => {
    clearBillingProviders();
    await database?.dispose();
  });

  const db = () => database.db;

  const workspace = async (label: string) => {
    sequence += 1;
    const made = await createPaidWorkspace(db(), `checkout-${label}-${String(sequence)}`);
    // On the catalogue's Growth plan rather than the harness's everything-plan, so the price the screen
    // quotes is one the published catalogue actually names.
    await setWorkspaceSubscription(db(), made.owner, { planVersionId: growthPlanVersionId, state: "ACTIVE" });
    return made;
  };

  const screen = async (
    made: Awaited<ReturnType<typeof workspace>>,
    query: Record<string, string> = { plan: growthPlanVersionId },
    locale = "en",
    who = made.owner,
  ) => assembleCheckoutScreen(db(), who, query, BASE, locale, NOW);

  /** The form a person would actually submit: every required box ticked, and the offered set declared. */
  const submission = (ids: readonly string[]): FormData => {
    const form = new FormData();
    for (const id of ids) {
      form.append("accept", id);
      form.append("offered", id);
    }
    return form;
  };

  describe("what it shows", () => {
    it("names the seller, the price and every document that needs a tick", async () => {
      const made = await workspace("shows");

      const data = await screen(made);

      expect(data.offer?.seller.legalName).toBe("Web Example SRL");
      expect(data.offer?.base.currency).toBe("EUR");
      expect(data.required.map((document) => document.kind).sort()).toEqual(["PUBLIC_OFFER", "TERMS_OF_SERVICE"]);
      // The refund policy exists and is not required, so it is linked rather than ticked.
      expect(data.linked.map((document) => document.kind)).toEqual(["REFUND_POLICY"]);
      expect(data.providerIsSeller).toBe(false);
      expect(data.offer?.checkoutReady).toBe(true);
    }, 300_000);

    it("gives an admin a page rather than an unhandled error", async () => {
      // `readCheckoutOffer` enforces OWNER by throwing, so a screen that asked it first would turn an
      // admin following this link into a 500. The convention everywhere else is a restricted sentence.
      const made = await workspace("admin");

      const data = await screen(made, { plan: growthPlanVersionId }, "en", made.admin);

      expect(data.canManage).toBe(false);
      expect(data.offer).toBeUndefined();
      expect(data.refusal).toBeUndefined();
    }, 300_000);

    it("explains itself when the link carries no plan", async () => {
      const made = await workspace("no-plan");

      expect((await screen(made, {})).refusal?.reason).toBe("NO_PRICE");
    }, 300_000);

    it("has a sentence for every refusal the store can produce", () => {
      // Iterated over the store's own exported union, so a reason added later cannot ship without one.
      for (const reason of CHECKOUT_REFUSALS) {
        const key = CHECKOUT_REFUSAL_MESSAGES[reason];
        expect(catalogues.en[key], reason).toBeTruthy();
        expect(catalogues.ru[key], reason).toBeTruthy();
      }
    });

    it("still offers the terms to a reader whose language they are not published in", async () => {
      // The #46 defect, at the surface that would have shown it: an exact-locale filter left a Russian
      // reader with no acceptance control at all, and the checkout then died on a constraint.
      const made = await workspace("ru-reader");

      const data = await screen(made, { plan: growthPlanVersionId }, "ru");

      expect(data.required.map((document) => document.kind).sort()).toEqual(["PUBLIC_OFFER", "TERMS_OF_SERVICE"]);
      for (const document of data.required) {
        expect(document.locale, document.kind).toBe("en");
        expect(document.inViewerLanguage, document.kind).toBe(false);
      }
      expect(data.offer?.viewerLocale).toBe("ru");
    }, 300_000);
  });

  describe("what it enforces", () => {
    it("refuses a submission with a box unticked, whatever the page claimed it rendered", async () => {
      // The claim channel is `offered`: this posts both ids as rendered and ticks one. A client that
      // lied about either would still be measured against what the store itself would offer now.
      const made = await workspace("unticked");
      const data = await screen(made);
      const ids = data.required.map((document) => document.legalDocumentId);
      expect(ids.length).toBe(2);

      const form = new FormData();
      form.append("accept", ids[0] ?? "");
      for (const id of ids) {
        form.append("offered", id);
      }

      const refused = await openCheckoutContract(db(), made.owner, {
        planVersionId: growthPlanVersionId,
        interval: "MONTH",
        arrangement: "RECURRING",
        currency: "EUR",
        locale: "en",
        acceptedDocumentIds: acceptedDocumentIdsFrom(form),
        offeredDocumentIds: offeredDocumentIdsFrom(form),
        at: NOW,
      });

      expect(refused).toMatchObject({ available: false, reason: "TERMS_NOT_ACCEPTED" });
      expect(await db().checkoutContract.count({ where: { workspaceId: made.workspaceId } })).toBe(0);
      expect(await db().legalAcceptance.count({ where: { workspaceId: made.workspaceId } })).toBe(0);
    }, 300_000);

    it("records the acceptance snapshot when every box is ticked", async () => {
      const made = await workspace("accepted");
      const data = await screen(made, { plan: growthPlanVersionId }, "ru");
      const ids = data.required.map((document) => document.legalDocumentId);

      const opened = await openCheckoutContract(db(), made.owner, {
        planVersionId: growthPlanVersionId,
        interval: "MONTH",
        arrangement: "RECURRING",
        currency: "EUR",
        locale: "ru",
        acceptedDocumentIds: acceptedDocumentIdsFrom(submission(ids)),
        offeredDocumentIds: offeredDocumentIdsFrom(submission(ids)),
        at: NOW,
      });

      expect(opened.available).toBe(true);
      if (!opened.available) {
        return;
      }
      const acceptances = await db().legalAcceptance.findMany({
        where: { checkoutContractId: opened.checkoutContractId },
        select: { locale: true, acceptedAt: true, actorUserId: true, legalDocument: { select: { kind: true, version: true, locale: true } } },
      });

      expect(acceptances.map((row) => row.legalDocument.kind).sort()).toEqual(["PUBLIC_OFFER", "TERMS_OF_SERVICE"]);
      for (const row of acceptances) {
        // The issue's list: workspace and user, the document version, when, and the reader's locale.
        expect(row.actorUserId, row.legalDocument.kind).toBe(made.owner.userId);
        expect(row.acceptedAt.toISOString(), row.legalDocument.kind).toBe(NOW.toISOString());
        expect(row.locale, row.legalDocument.kind).toBe("ru");
        expect(row.legalDocument.locale, row.legalDocument.kind).toBe("en");
      }
      // And the contract is the attempt reference the acceptance points at.
      expect(acceptances.length).toBe(2);
    }, 300_000);

    it("refuses an admin's hand-made submission at the store, not at the screen", async () => {
      const made = await workspace("admin-post");
      const data = await screen(made);
      const ids = data.required.map((document) => document.legalDocumentId);

      await expect(
        openCheckoutContract(db(), made.admin, {
          planVersionId: growthPlanVersionId,
          interval: "MONTH",
          arrangement: "RECURRING",
          currency: "EUR",
          locale: "en",
          acceptedDocumentIds: acceptedDocumentIdsFrom(submission(ids)),
          at: NOW,
        }),
      ).rejects.toThrow(/open a checkout/u);
    }, 300_000);
  });
});
