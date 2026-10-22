/**
 * The step between choosing a plan and being sent to a payment page (#47, ADR-019).
 *
 * This screen exists because of one sentence in the spec: acceptance of the Public Offer and the Terms is
 * evidenced by an explicit control *before* the redirect, not by the later act of payment. A product that
 * inferred consent from a completed charge would have no record of what anybody agreed to, and no way to
 * answer the only question a dispute asks — which version, in which language, by whom, and when.
 *
 * So the page shows four things a person has to be able to read before they commit: **who is selling to
 * them** (the legal entity, not the product's brand), **what it costs**, **who remits the tax** — because
 * on a Merchant-of-Record route the invoice is the provider's and its own terms additionally apply at its
 * hosted checkout — and **the exact document versions** they are accepting, each as its own tick, none
 * pre-ticked.
 *
 * Free of the authenticated request path on purpose, exactly like `billing-screen.ts`: `checkout-page.ts`
 * adds the authorization and the translator and cannot be imported under Vitest, so everything a test
 * needs to drive lives on this side of the line.
 *
 * **Nothing here decides anything.** The server refuses a submission with a box unticked whatever this
 * screen rendered, refuses a superseded version, and refuses a route whose provider cannot settle — see
 * `openCheckoutContract`. What this file decides is only what somebody is *shown*.
 */
import {
  readCheckoutOffer,
  type CheckoutOffer,
  type CheckoutRefusalReason,
  type DbClient,
  type LegalDocumentOffer,
  type WorkspaceContext,
} from "@omnichannel/db";
import { isChargeInterval, type ArrangementKind, type ChargeInterval } from "@omnichannel/domain";

import type { MessageKey } from "@/i18n/catalogue";
import type { RawSearchParams } from "@/server/inbox-view";
import { one } from "@/server/style-view";

/**
 * The interval a checkout defaults to when the link did not say.
 *
 * Monthly, because it is the smaller commitment and a page that defaulted to the annual term would be
 * quoting somebody a year's price they did not ask for.
 */
export const DEFAULT_CHECKOUT_INTERVAL: ChargeInterval = "MONTH";

/** The currency the catalogue is priced in for this deployment. */
export const DEFAULT_CHECKOUT_CURRENCY = "EUR";

/** A recurring subscription unless a route can only do prepaid terms, which #41's adapter will decide. */
export const DEFAULT_ARRANGEMENT: ArrangementKind = "RECURRING";

export interface CheckoutSelection {
  readonly planVersionId: string;
  readonly interval: ChargeInterval;
  readonly currency: string;
  readonly arrangement: ArrangementKind;
}

/**
 * The sentence for each way a checkout could not be offered (#47).
 *
 * A total map over `CHECKOUT_REFUSALS` rather than a ternary chain, so adding a refusal reason is a type
 * error here instead of a page that renders nothing for it. The grouping is by whose problem it is: the
 * first three are the customer's circumstances, and the rest are an operator's — a route to enable, an
 * adapter to wire, a document to publish — and telling a customer they got something wrong would send
 * them looking for a fault that is not theirs.
 */
export const CHECKOUT_REFUSAL_MESSAGES: Readonly<Record<CheckoutRefusalReason, MessageKey>> = {
  ARRANGEMENT_EXISTS: "checkout.refusedArrangementExists",
  NO_PRICE: "checkout.refusedNoPrice",
  TERMS_NOT_ACCEPTED: "outcome.TERMS_NOT_ACCEPTED",
  DOCUMENT_SUPERSEDED: "outcome.TERMS_CHANGED",
  OFFER_CHANGED: "outcome.OFFER_CHANGED",
  DOCUMENT_NOT_APPLICABLE: "checkout.refusedDocumentNotApplicable",
  NO_ROUTE: "checkout.refusedUnavailable",
  PROVIDER_UNAVAILABLE: "checkout.refusedUnavailable",
  DOCUMENT_UNAVAILABLE: "checkout.refusedDocumentUnavailable",
};

export interface CheckoutScreenData {
  /** What the link asked for, echoed so the form posts back exactly what was priced. */
  readonly selection: CheckoutSelection;
  /** The plan's own name and version, for a heading somebody can recognise. */
  readonly plan?: { readonly code: string; readonly name: string; readonly version: number };
  /** Present when a checkout could be described at all. */
  readonly offer?: CheckoutOffer;
  /** Why not, when it could not. */
  readonly refusal?: { readonly reason: CheckoutRefusalReason; readonly detail: readonly string[] };
  /** The documents that need a tick, in the catalogue's own order. */
  readonly required: readonly LegalDocumentOffer[];
  /** The documents that are linked rather than ticked: privacy, refunds, anything configuration says. */
  readonly linked: readonly LegalDocumentOffer[];
  /** True when the provider's own terms additionally apply, which is what a Merchant of Record means. */
  readonly providerIsSeller: boolean;
  readonly canManage: boolean;
  readonly basePath: string;
  readonly billingPath: string;
}

/**
 * Reads the selection out of the query string, refusing anything it does not recognise.
 *
 * A query parameter is attacker-controlled, so an unknown interval becomes the default rather than being
 * passed through: the store would refuse it anyway, and a page that echoed `interval=whenever` back into
 * a form would be rendering a stranger's text inside the shell.
 */
export function checkoutSelectionFrom(searchParams: RawSearchParams): CheckoutSelection {
  const interval = one(searchParams["interval"]);
  return {
    planVersionId: one(searchParams["plan"]) ?? "",
    interval: interval !== undefined && isChargeInterval(interval) ? interval : DEFAULT_CHECKOUT_INTERVAL,
    currency: DEFAULT_CHECKOUT_CURRENCY,
    arrangement: DEFAULT_ARRANGEMENT,
  };
}

export async function assembleCheckoutScreen(
  db: DbClient,
  context: WorkspaceContext,
  searchParams: RawSearchParams,
  basePath: string,
  viewerLocale: string,
  at = new Date(),
): Promise<CheckoutScreenData> {
  const selection = checkoutSelectionFrom(searchParams);
  const billingPath = basePath.replace(/\/checkout$/u, "");
  const canManage = context.role === "OWNER";
  const frame = { selection, canManage, basePath, billingPath, providerIsSeller: false, required: [], linked: [] } as const;

  if (!canManage) {
    // Commercial changes are the owner's, and `readCheckoutOffer` enforces that by *throwing*. An admin
    // who follows or guesses this link has to get the restricted sentence every other screen gives them,
    // not an unhandled error out of a page render — so the role is answered before the store is asked.
    return frame;
  }

  if (selection.planVersionId === "") {
    // Reached without a plan. Not an error anybody made: the billing page is one link away, and the
    // store would refuse a blank plan with a reason about prices that would read like a fault.
    return { ...frame, refusal: { reason: "NO_PRICE", detail: [] } };
  }

  const plan = await db.planVersion.findUnique({
    where: { id: selection.planVersionId },
    select: { version: true, plan: { select: { code: true, name: true } } },
  });
  const named = plan === null ? {} : { plan: { code: plan.plan.code, name: plan.plan.name, version: plan.version } };

  const offer = await readCheckoutOffer(db, context, { ...selection, locale: viewerLocale }, at);
  if (!offer.available) {
    return { ...frame, ...named, refusal: { reason: offer.reason, detail: offer.detail } };
  }

  return {
    ...frame,
    ...named,
    offer,
    // Split here rather than in the pane, so the acceptance control and the link list cannot disagree
    // about which documents need consent — the server reads the same `requiredForCheckout` when it
    // refuses the submission.
    required: offer.documents.filter((document) => document.requiredForCheckout),
    linked: offer.documents.filter((document) => !document.requiredForCheckout),
    providerIsSeller: offer.settlementModel === "MERCHANT_OF_RECORD",
  };
}
