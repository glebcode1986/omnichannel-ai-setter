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
 * There is deliberately no redirect to a provider here. Until #41 chooses one there is nothing to redirect
 * to, and `openCheckoutContract` refuses a route whose provider has no adapter — so the honest end of this
 * action is a contract with its acceptance snapshot and a sentence saying the payment step is next.
 */
import { openCheckoutContract, WorkspacePermissionError, type CheckoutRefusalReason } from "@omnichannel/db";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { requestLocale } from "@/i18n/request-locale";
import { acceptedDocumentIdsFrom, offeredDigestFrom, offeredDocumentIdsFrom, field } from "./checkout-form";
import { checkoutSelectionFrom } from "./checkout-screen";
import { getDb } from "./db";
import { requireWorkspaceContext } from "./request-context";

/**
 * What the billing page says afterwards.
 *
 * The store's refusal reasons are mapped to the screen's own vocabulary rather than passed through: a
 * person reading "DOCUMENT_SUPERSEDED" learns nothing, and the two that matter here —
 * "you did not tick the box" and "the terms changed while you were reading" — need different sentences
 * and different next steps.
 */
export type CheckoutOutcome = "ACCEPTED" | "TERMS_NOT_ACCEPTED" | "TERMS_CHANGED" | "CHECKOUT_UNAVAILABLE" | "REFUSED";

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

  try {
    const opened = await openCheckoutContract(getDb(), context, {
      ...selection,
      locale,
      acceptedDocumentIds: acceptedDocumentIdsFrom(formData),
      offeredDocumentIds: offeredDocumentIdsFrom(formData),
      ...(offeredDigestFrom(formData) === undefined ? {} : { offeredDigest: offeredDigestFrom(formData) }),
    });
    finish(target, opened.available ? "ACCEPTED" : outcomeOf(opened.reason));
  } catch (error) {
    if (error instanceof WorkspacePermissionError) {
      finish(target, "REFUSED");
    }
    throw error;
  }
}
