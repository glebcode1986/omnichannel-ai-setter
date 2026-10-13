"use server";

/**
 * Accepting the terms and opening a checkout (#47, ADR-019).
 *
 * One action, and what it does *not* do is the point. It does not take a payment, it does not grant an
 * entitlement, and it does not believe anything the form says about which documents were on the page: it
 * records the acceptance and opens the contract in one transaction, and the store re-resolves the route,
 * the price and the current document versions inside that transaction rather than trusting the browser
 * that drew the checkboxes.
 *
 * Authorization is re-resolved from the database on every call and the store refuses anyone but an OWNER,
 * so a hand-made POST from an admin's session is refused by the store rather than by this file hiding a
 * button. The screen's `canManage` decides what is *offered*; the server decides what is permitted.
 *
 * The provider hand-off happens *after* the contract commits (#41). That order is forced rather than
 * chosen: the contract is the record of what was agreed and by whom, and a provider session opened before
 * it would leave a paid session with nothing to attribute the settlement to. Where this deployment cannot
 * open one — no adapter, no return URL, no published provider price — the action ends exactly as it did
 * before: a contract with its acceptance snapshot, and a sentence saying the payment step is next.
 *
 * The redirect grants nothing. It is a page; the only thing that activates a paid entitlement is a
 * verified provider event or an authoritative reconciliation.
 */
import { openCheckoutContract, WorkspacePermissionError, type CheckoutRefusalReason } from "@omnichannel/db";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { loadWebEnv } from "../env";
import { requestLocale } from "@/i18n/request-locale";
import { ensureBillingAdapters } from "./billing-adapters";
import { acceptedDocumentIdsFrom, offeredDocumentIdsFrom, field } from "./checkout-form";
import { checkoutSelectionFrom } from "./checkout-screen";
import { getDb } from "./db";
import { getLogger } from "./logger";
import { requestProviderCheckout } from "./provider-checkout";
import { requireWorkspaceContext } from "./request-context";

/**
 * What the billing page says afterwards.
 *
 * The store's refusal reasons are mapped to the screen's own vocabulary rather than passed through: a
 * person reading "DOCUMENT_SUPERSEDED" learns nothing, and the two that matter here —
 * "you did not tick the box" and "the terms changed while you were reading" — need different sentences
 * and different next steps.
 */
export type CheckoutOutcome =
  | "ACCEPTED"
  | "TERMS_NOT_ACCEPTED"
  | "TERMS_CHANGED"
  | "CHECKOUT_UNAVAILABLE"
  | "REFUSED"
  /** The provider's page was opened and could not be reached, or answered something unusable. */
  | "PROVIDER_UNREACHABLE";

export interface CheckoutTarget {
  readonly workspaceId: string;
  readonly businessProfileId: string;
}

const billingPath = (target: CheckoutTarget) => `/workspaces/${target.workspaceId}/profiles/${target.businessProfileId}/settings/billing`;

function finish(target: CheckoutTarget, outcome: CheckoutOutcome): never {
  const path = billingPath(target);
  revalidatePath(path);
  redirect(`${path}?outcome=${outcome}`);
}

/** The reasons a person can do something about, and the reasons somebody else has to. */
function outcomeOf(reason: CheckoutRefusalReason): CheckoutOutcome {
  if (reason === "TERMS_NOT_ACCEPTED") {
    return "TERMS_NOT_ACCEPTED";
  }
  if (reason === "DOCUMENT_SUPERSEDED") {
    return "TERMS_CHANGED";
  }
  if (reason === "PROVIDER_UNAVAILABLE" || reason === "NO_ROUTE" || reason === "DOCUMENT_UNAVAILABLE") {
    // Nothing the customer did. An operator has to enable a route, wire an adapter or publish a document,
    // and telling the customer they got something wrong would send them looking for a fault that is not
    // theirs.
    return "CHECKOUT_UNAVAILABLE";
  }
  return "REFUSED";
}

export async function acceptTermsAndOpenCheckoutAction(target: CheckoutTarget, formData: FormData): Promise<void> {
  const context = await requireWorkspaceContext(target.workspaceId);
  // The selection is rebuilt from the posted fields through the same reader the page used, so a hand-made
  // POST cannot name an interval the catalogue does not price.
  const selection = checkoutSelectionFrom({ plan: field(formData, "plan"), interval: field(formData, "interval") });
  const locale = await requestLocale();

  let handoff: Awaited<ReturnType<typeof requestProviderCheckout>>;
  try {
    const opened = await openCheckoutContract(getDb(), context, {
      ...selection,
      locale,
      acceptedDocumentIds: acceptedDocumentIdsFrom(formData),
      offeredDocumentIds: offeredDocumentIdsFrom(formData),
    });
    if (!opened.available) {
      finish(target, outcomeOf(opened.reason));
    }
    handoff = await requestProviderCheckout({
      db: getDb(),
      logger: getLogger(),
      checkoutContractId: opened.checkoutContractId,
      returnBaseUrl: loadWebEnv().BILLING_RETURN_BASE_URL,
      returnPath: billingPath(target),
      ensureAdapters: ensureBillingAdapters,
    });
  } catch (error) {
    if (error instanceof WorkspacePermissionError) {
      finish(target, "REFUSED");
    }
    // The contract committed and the provider could not be reached. Said as its own outcome rather than
    // as a failure: the acceptance is recorded, nothing was charged, and pressing the button again opens
    // a session against the same contract — which is why the idempotency key is the contract's id.
    getLogger().error("billing.checkout_handoff_failed", { errorName: error instanceof Error ? error.name : typeof error });
    finish(target, "PROVIDER_UNREACHABLE");
  }

  if (handoff === undefined) {
    // Nothing to redirect to, and the contract stands. The billing page says the payment step is next.
    finish(target, "ACCEPTED");
  }
  if (handoff.kind === "REDIRECT") {
    revalidatePath(billingPath(target));
    redirect(handoff.url);
  }
  // A provider whose hand-off is a signed form cannot be completed by a redirect, and this screen has no
  // form to post it from yet. Reported as unavailable rather than half-done: the contract is written, and
  // nothing pretends a customer was handed anywhere.
  finish(target, "CHECKOUT_UNAVAILABLE");
}
