/**
 * One Stripe event, read as a product billing event.
 *
 * Verified against the live documentation on 2026-10-12: https://docs.stripe.com/api/events/object,
 * https://docs.stripe.com/api/events/types, https://docs.stripe.com/api/invoices/object,
 * https://docs.stripe.com/api/subscriptions/object and https://docs.stripe.com/billing/subscriptions/webhooks.
 *
 * **Attribution travels in metadata, and it has to.** The store resolves an arrangement from the event's
 * own `arrangementId` or from the checkout contract it names, and from nothing else — there is no lookup
 * by provider reference. A renewal three months later therefore has to carry the contract id, which is
 * why `openCheckout` writes it into the subscription's metadata and why every renewal reads it back from
 * `invoice.parent.subscription_details.metadata`, documented as "an immutable snapshot of the subscription
 * metadata at the time of invoice finalization". Without that, every renewal would be recorded
 * `UNATTRIBUTED` and no month after the first would extend anything.
 *
 * **An event type this adapter does not map is `NO_EVENT`, never a refusal.** The endpoint should be
 * subscribed only to the types below, and an unexpected one is then a misconfiguration rather than an
 * attack — but a provider that is refused redelivers for three days, so the honest answer is "authentic,
 * and I have nothing to say about it".
 *
 * **Refunds and disputes are deliberately not mapped.** A refund arrives on a charge, and a charge carries
 * no subscription metadata, so attributing one would take a second API call and a design decision about
 * partial refunds that Issue #41 does not ask for. They are therefore not subscribed to and not
 * implemented, rather than mapped to something that looks handled. See ADR-020.
 *
 * **`created` is not used for ordering.** The docs say so in as many words — snapshot events record it in
 * seconds, so two events can share a timestamp — and the product's own store handles reordering by what
 * an effect is allowed to do, not by comparing dates. `occurredAt` is reported because the audit trail
 * wants to know when the provider said it, not so that anything sorts on it.
 */
import type { NormalizedBillingEvent } from "@omnichannel/application";

import { asCurrency, asInstant, asInteger, asObject, asString, metadataValue } from "./api";

/**
 * The metadata key the contract id travels under.
 *
 * Deliberately not the plan, the workspace or the price: one opaque reference, written once at checkout,
 * and the only thing that ties a settlement back to a customer. Stripe metadata is visible in the
 * merchant dashboard, so what goes in it is an identifier and nothing else.
 */
export const CONTRACT_METADATA_KEY = "checkout_contract_id";

/** What a mapped event became, or why it was not mapped. */
export type MappedEvent =
  | { readonly kind: "EVENT"; readonly event: NormalizedBillingEvent }
  /** Authentic, and this adapter has nothing for the product to record. */
  | { readonly kind: "NO_EVENT" }
  /** The body was not a Stripe event at all, which an authentic delivery should never be. */
  | { readonly kind: "UNREADABLE" };

export function mapStripeEvent(routeCode: string, payload: unknown): MappedEvent {
  const event = asObject(payload);
  const id = asString(event?.["id"]);
  const type = asString(event?.["type"]);
  const occurredAt = asInstant(event?.["created"]);
  const object = asObject(asObject(event?.["data"])?.["object"]);
  if (event === undefined || id === undefined || type === undefined || occurredAt === undefined || object === undefined) {
    return { kind: "UNREADABLE" };
  }
  const base = { routeCode, providerEventId: id, occurredAt } as const;

  switch (type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      return fromCheckoutSession(base, object, "SETTLED");
    case "checkout.session.async_payment_failed":
      return fromCheckoutSession(base, object, "FAILED");
    case "checkout.session.expired":
      return fromCheckoutSession(base, object, "EXPIRED");
    case "invoice.paid":
      return fromInvoice(base, object, "PAID");
    case "invoice.payment_failed":
      return fromInvoice(base, object, "FAILED");
    case "customer.subscription.deleted":
      return fromSubscriptionEnd(base, object);
    default:
      // Including `customer.subscription.updated`: a subscription that has been *scheduled* to cancel has
      // not ended, the customer has paid for the period they are in, and the product has no event for
      // "will end later". The end arrives as `customer.subscription.deleted` when the period runs out.
      return { kind: "NO_EVENT" };
  }
}

type EventBase = Pick<NormalizedBillingEvent, "routeCode" | "providerEventId" | "occurredAt">;

function fromCheckoutSession(base: EventBase, session: Readonly<Record<string, unknown>>, outcome: "SETTLED" | "FAILED" | "EXPIRED"): MappedEvent {
  // `client_reference_id` is what `openCheckout` put there: the product's own checkout contract id.
  const contractId = asString(session["client_reference_id"]);
  if (contractId === undefined) {
    // A session this product did not open — a Dashboard payment link, say. Authentic and not ours.
    return { kind: "NO_EVENT" };
  }
  const settled = money(session["amount_total"], session["currency"]);
  const subscription = asString(session["subscription"]);
  if (outcome === "EXPIRED") {
    return {
      kind: "EVENT",
      event: { ...base, kind: "QUOTE_EXPIRED", checkoutContractId: contractId },
    };
  }
  if (outcome === "FAILED") {
    return {
      kind: "EVENT",
      event: { ...base, kind: "PAYMENT_FAILED", checkoutContractId: contractId },
    };
  }
  // Only a session whose payment Stripe calls settled settles. `paid` is the ordinary case and covers a
  // zero-amount trial invoice; `no_payment_required` is a trial or an anchored billing cycle where the
  // money comes later, and the product treats the arrangement as live for both — an entitlement and a
  // payment are different questions, and a trial is an entitlement somebody was granted. `unpaid` is
  // neither: a delayed payment method has not cleared, and `checkout.session.async_payment_succeeded` is
  // the event that says it finally did. Written as an allowlist, so a fourth value Stripe adds is
  // treated as "not settled" rather than silently settling.
  const paymentStatus = asString(session["payment_status"]);
  if (paymentStatus !== "paid" && paymentStatus !== "no_payment_required") {
    return { kind: "NO_EVENT" };
  }
  return {
    kind: "EVENT",
    event: {
      ...base,
      kind: "PAYMENT_SETTLED",
      checkoutContractId: contractId,
      ...(settled === undefined ? {} : { settled }),
      // The subscription is what reconciliation later asks the provider about. Absent for a prepaid term,
      // which has no subscription to read.
      ...(subscription === undefined ? {} : { providerReference: subscription }),
    },
  };
}

function fromInvoice(base: EventBase, invoice: Readonly<Record<string, unknown>>, outcome: "PAID" | "FAILED"): MappedEvent {
  const subscriptionDetails = asObject(asObject(invoice["parent"])?.["subscription_details"]);
  if (subscriptionDetails === undefined) {
    // An invoice with no subscription parent is not part of a subscription: a one-off invoice raised in
    // the Dashboard, or a quote. Not this product's charge path.
    return { kind: "NO_EVENT" };
  }
  const contractId = metadataValue(subscriptionDetails["metadata"], CONTRACT_METADATA_KEY);
  const subscription = asString(subscriptionDetails["subscription"]);
  const reason = asString(invoice["billing_reason"]);
  if (contractId === undefined) {
    // A subscription this product did not create, or one created before the metadata snapshot existed.
    // Nothing can be attributed, and inventing an attribution is the one thing that must not happen.
    return { kind: "NO_EVENT" };
  }
  const base_ = {
    ...base,
    checkoutContractId: contractId,
    ...(subscription === undefined ? {} : { providerReference: subscription }),
  };
  if (outcome === "FAILED") {
    return { kind: "EVENT", event: { ...base_, kind: "PAYMENT_FAILED" } };
  }
  const settled = money(invoice["amount_paid"], invoice["currency"]);
  // The first invoice of a subscription is the same money the checkout session reported, and it is
  // reported as a settlement too rather than as a renewal: `ACTIVATE` is idempotent in effect, so if the
  // checkout event is lost this is still the event that starts the arrangement. Every later invoice is a
  // renewal, which extends a period rather than starting one — and arriving before the activation it
  // depends on, the store answers `NONE` rather than treating it as a start.
  const kind = reason === "subscription_create" ? "PAYMENT_SETTLED" : "SUBSCRIPTION_RENEWED";
  return {
    kind: "EVENT",
    event: {
      ...base_,
      kind,
      ...(settled === undefined ? {} : { settled }),
      // Not `invoice.period_end`: the docs say that is the latest instant an item may be attached to the
      // invoice, and point at the line item's own period for the service period. Left absent, the store
      // computes the period from the arrangement's interval, which is the product's own answer; the
      // authoritative one comes from `reconcile`, where the subscription itself states it.
    },
  };
}

function fromSubscriptionEnd(base: EventBase, subscription: Readonly<Record<string, unknown>>): MappedEvent {
  const contractId = metadataValue(subscription["metadata"], CONTRACT_METADATA_KEY);
  if (contractId === undefined) {
    return { kind: "NO_EVENT" };
  }
  const id = asString(subscription["id"]);
  return {
    kind: "EVENT",
    event: {
      ...base,
      kind: "SUBSCRIPTION_CANCELED",
      checkoutContractId: contractId,
      ...(id === undefined ? {} : { providerReference: id }),
    },
  };
}

function money(amount: unknown, currency: unknown): NormalizedBillingEvent["settled"] {
  const amountMinor = asInteger(amount);
  const code = asCurrency(currency);
  // Both or neither. An amount without a currency is not an amount, and the port's own check would
  // refuse the event rather than record half of one.
  return amountMinor === undefined || code === undefined ? undefined : { amountMinor, currency: code };
}
