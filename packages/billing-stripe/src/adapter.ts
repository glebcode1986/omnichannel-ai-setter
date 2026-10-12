/**
 * Stripe, as one implementation of the application's billing provider port (Issue #41, ADR-017, ADR-020).
 *
 * Verified against the live documentation on 2026-10-12, API version pinned at `2026-09-30.endive`.
 *
 * **The route is established by the signature, not by the request.** A delivery arrives with no trusted
 * statement about which billing route it belongs to — a URL path could say so, and a URL path is chosen by
 * whoever sends the request. Each route has its own Stripe endpoint and therefore its own signing secret,
 * so the secret that verifies a delivery *is* the answer, and it is an answer an attacker cannot
 * influence. One process serves several sellers (ADR-019 binds each route to one seller profile and one
 * provider account), and this is what keeps the Ukrainian FOP's events off the Romanian company's route.
 *
 * **Nothing here reaches a database.** The adapter reports a normalized event and the port mints it; the
 * store decides what it means. An adapter that could write would be able to activate a paid entitlement
 * without a verified event, which is the one thing this whole boundary exists to prevent — and
 * `billing-stripe -> db` is a forbidden dependency so that it cannot be added by accident.
 *
 * **Secrets stay in configuration.** A route's secret key and signing secrets are passed in by the
 * composition root, used as a header and a HMAC key, and never logged, returned, or put in an error. The
 * only provider strings that leave this package are opaque identifiers: a session id, a subscription id, a
 * request id.
 */
import type {
  BillingProviderAdapter,
  CheckoutHandoff,
  NormalizedBillingEvent,
  ProviderCheckoutRequest,
  ProviderManagementRequest,
  ProviderRenewalRequest,
  ProviderRenewalState,
  RawProviderDelivery,
  ReconciliationQuery,
  VerifiedDelivery,
} from "@omnichannel/application";

import { asBoolean, asInstant, asObject, asString, callStripe, metadataValue, StripeCallFailed, type StripeObject } from "./api";
import { CONTRACT_METADATA_KEY, mapStripeEvent } from "./events";
import { STRIPE_SIGNATURE_HEADER, verifyStripeSignature } from "./signature";
import { createFetchBillingHttpPort, type BillingHttpPort } from "./transport";

export const STRIPE_PROVIDER = "stripe";

/** One Stripe account, as one billing route uses it. */
export interface StripeRouteConfig {
  /** The product's own `billing_routes.code`. Never a Stripe identifier. */
  readonly routeCode: string;
  /** `sk_live_…` or, preferably, a restricted `rk_live_…`. Held here, never logged or returned. */
  readonly secretKey: string;
  /**
   * The endpoint's `whsec_…` signing secrets.
   *
   * Plural because rolling a secret leaves the previous one active for up to 24 hours, and during that
   * window Stripe signs each delivery once per active secret.
   */
  readonly webhookSecrets: readonly string[];
}

export interface StripeAdapterConfig {
  readonly routes: readonly StripeRouteConfig[];
  readonly http?: BillingHttpPort;
  readonly now?: () => Date;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

export function createStripeBillingAdapter(config: StripeAdapterConfig): BillingProviderAdapter {
  const http = config.http ?? createFetchBillingHttpPort();
  const now = config.now ?? (() => new Date());
  const routes = new Map(config.routes.filter((route) => route.routeCode.trim() !== "").map((route) => [route.routeCode, route]));

  const call = async (route: StripeRouteConfig, request: Omit<Parameters<typeof callStripe>[1], "secretKey" | "baseUrl" | "timeoutMs">) =>
    callStripe(http, {
      ...request,
      secretKey: route.secretKey,
      ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
      ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    });

  const routeFor = (routeCode: string): StripeRouteConfig => {
    const route = routes.get(routeCode);
    if (route === undefined) {
      // Not configured in this process. `REJECTED` with no status, because nothing was asked of Stripe:
      // the caller has to be able to tell "this deployment cannot serve that route" from "Stripe said no".
      throw new StripeCallFailed("REJECTED");
    }
    return route;
  };

  return {
    provider: STRIPE_PROVIDER,

    verify(delivery: RawProviderDelivery): VerifiedDelivery | null {
      const header = headerOf(delivery, STRIPE_SIGNATURE_HEADER);
      // Every configured route is tried, and the one whose secret authenticates the delivery is the route
      // it arrived for. A handful of routes means a handful of HMACs, each constant-time.
      const route = [...routes.values()].find(
        (candidate) =>
          verifyStripeSignature({ body: delivery.body, header, secrets: candidate.webhookSecrets, now: delivery.receivedAt }).status === "VERIFIED",
      );
      if (route === undefined) {
        return null;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(delivery.body);
      } catch {
        // Authentic and unreadable. Refused rather than acknowledged: Stripe signed a body this adapter
        // cannot parse, which is a defect somebody has to see, and an acknowledgement would discard it
        // silently. The redelivery schedule is the backstop.
        return null;
      }
      const mapped = mapStripeEvent(route.routeCode, payload);
      if (mapped.kind === "UNREADABLE") {
        return null;
      }
      return mapped.kind === "NO_EVENT" ? { kind: "NO_EVENT" } : { kind: "EVENT", event: mapped.event };
    },

    async openCheckout(request: ProviderCheckoutRequest): Promise<CheckoutHandoff> {
      const route = routeFor(request.routeCode);
      const subscription = request.arrangement === "RECURRING";
      const session = await call(route, {
        method: "POST",
        path: "/v1/checkout/sessions",
        // The contract id, so a retried request returns the session the first one created rather than a
        // second charge path. Deterministic on purpose: the contract is immutable, so the parameters
        // cannot differ between attempts and the key cannot collide with a different request.
        idempotencyKey: `checkout:${request.clientReference}`,
        fields: {
          mode: subscription ? "subscription" : "payment",
          // A flat key that contains brackets, which is how Stripe's form encoding spells a nested array.
          "line_items[0][price]": request.priceReference,
          "line_items[0][quantity]": 1,
          success_url: request.successUrl,
          cancel_url: request.cancelUrl,
          // What comes back on `checkout.session.completed`, and the only thing tying the settlement to a
          // customer. Opaque and workspace-scoped; Stripe allows 200 characters.
          client_reference_id: request.clientReference,
          // And the same id on the subscription, because a renewal event carries the subscription's
          // metadata and nothing else that could attribute it. Omitted for a prepaid term, which creates
          // no subscription.
          ...(subscription ? { [`subscription_data[metadata][${CONTRACT_METADATA_KEY}]`]: request.clientReference } : {}),
        },
      });
      const url = asString(session["url"]);
      if (url === undefined) {
        // A 2xx with no hosted page is not a hand-off. Better an operational failure than a redirect to
        // `undefined`.
        throw new StripeCallFailed("UNREADABLE");
      }
      const reference = asString(session["id"]);
      // The session id travels back so the contract can record which session it was handed to, once. A
      // settlement that could not be matched to a session is a settlement nobody can audit.
      return { kind: "REDIRECT", url, ...(reference === undefined ? {} : { reference }) };
    },

    async openManagementSession(request: ProviderManagementRequest): Promise<CheckoutHandoff> {
      const route = routeFor(request.routeCode);
      // The arrangement stores the subscription, and the portal is opened for a customer — so the
      // customer is read from the subscription rather than stored a second time. One fact, one home.
      const subscription = await call(route, { method: "GET", path: `/v1/subscriptions/${encodeURIComponent(request.providerReference)}` });
      const customer = asString(subscription["customer"]);
      if (customer === undefined) {
        throw new StripeCallFailed("UNREADABLE");
      }
      const session = await call(route, {
        method: "POST",
        path: "/v1/billing_portal/sessions",
        // No idempotency key: a portal session is a short-lived page, and returning the first one for
        // every later visit is the opposite of what somebody clicking "manage billing" wants.
        fields: {
          customer,
          return_url: request.returnUrl,
          ...(request.locale === undefined ? {} : { locale: request.locale }),
        },
      });
      const url = asString(session["url"]);
      if (url === undefined) {
        throw new StripeCallFailed("UNREADABLE");
      }
      return { kind: "REDIRECT", url };
    },

    async setRenewal(request: ProviderRenewalRequest): Promise<ProviderRenewalState> {
      const route = routeFor(request.routeCode);
      const subscription = await call(route, {
        method: "POST",
        path: `/v1/subscriptions/${encodeURIComponent(request.providerReference)}`,
        // Not a cancellation now. `cancel_at_period_end` lets the period the customer paid for run out,
        // and `false` undoes that while it is still running — which is the documented way to resume a
        // subscription that was scheduled to end. (`/v1/subscriptions/{id}/resume` is for a *paused*
        // subscription, a different state this product does not use.)
        fields: { cancel_at_period_end: request.renew ? "false" : "true" },
      });
      const periodEndsAt = periodEndOf(subscription);
      return { renews: renewsOf(subscription), ...(periodEndsAt === undefined ? {} : { periodEndsAt }) };
    },

    async reconcile(query: ReconciliationQuery): Promise<NormalizedBillingEvent | null> {
      const route = routeFor(query.routeCode);
      const subscription = await call(route, { method: "GET", path: `/v1/subscriptions/${encodeURIComponent(query.providerReference)}` });
      return stateOf(route.routeCode, subscription, now());
    },
  };
}

/**
 * Whether Stripe will charge again at the end of the current period.
 *
 * **Two fields, and both have to say no scheduled end.** New subscriptions use the `flexible` billing
 * mode by default, and in that mode Stripe's own guidance is to confirm a reactivation by checking that
 * `cancel_at` is `null`; only in `classic` mode is `cancel_at_period_end` the field that carries it. A
 * reader of one field alone is therefore right in one billing mode and wrong in the other — and the
 * direction it is wrong in matters, because a screen that says "renews" about an arrangement Stripe is
 * about to end is a screen that loses somebody their automation without warning.
 *
 * `cancel_at` also carries a cancellation scheduled for a specific future date, which is a third way the
 * answer is "no" and a third thing a single-field reader would miss.
 */
function renewsOf(subscription: StripeObject): boolean {
  const scheduledAt = asInstant(subscription["cancel_at"]);
  return scheduledAt === undefined && asBoolean(subscription["cancel_at_period_end"]) !== true;
}

/**
 * What the provider itself says, as an event the product can record.
 *
 * The repair path for a delivery that never arrived. `null` for a state that asserts nothing yet — an
 * `incomplete` subscription is one whose first payment has not been made, and a `paused` one is a trial
 * that ended without a payment method; neither is a settlement, a failure or an ending.
 */
function stateOf(routeCode: string, subscription: StripeObject, observedAt: Date): NormalizedBillingEvent | null {
  const id = asString(subscription["id"]);
  const contractId = metadataValue(subscription["metadata"], CONTRACT_METADATA_KEY);
  const status = asString(subscription["status"]);
  if (id === undefined || contractId === undefined || status === undefined) {
    return null;
  }
  const kind = RECONCILED_KINDS[status];
  if (kind === undefined) {
    return null;
  }
  const periodEndsAt = periodEndOf(subscription);
  return {
    routeCode,
    // An identifier for *this observation*, not for the subscription. Idempotency is keyed on it, so a
    // reconciliation that saw no change must not produce a second record — and one that saw a new state
    // must not be mistaken for the old one. The state and the period are therefore part of the id.
    providerEventId: `stripe:reconcile:${id}:${status}:${String(periodEndsAt?.getTime() ?? 0)}`,
    kind,
    occurredAt: observedAt,
    checkoutContractId: contractId,
    providerReference: id,
    ...(periodEndsAt === undefined ? {} : { periodEndsAt }),
  };
}

/**
 * Stripe's subscription statuses, as what the product should make of each.
 *
 * A total map rather than a switch with a default, so that a status Stripe adds is `undefined` here and
 * reconciliation says nothing, instead of a `default:` arm quietly deciding it means one of these.
 * `incomplete_expired` is terminal — the first invoice was never paid and never will be — so it ends the
 * arrangement rather than suspending it.
 */
const RECONCILED_KINDS: Readonly<Record<string, NormalizedBillingEvent["kind"] | undefined>> = {
  active: "PAYMENT_SETTLED",
  trialing: "PAYMENT_SETTLED",
  past_due: "PAYMENT_FAILED",
  unpaid: "PAYMENT_FAILED",
  canceled: "SUBSCRIPTION_CANCELED",
  incomplete_expired: "SUBSCRIPTION_CANCELED",
  incomplete: undefined,
  paused: undefined,
};

/**
 * When the paid period ends, read from where the current API keeps it.
 *
 * **Not `subscription.current_period_end`.** That field is no longer on the subscription object: the
 * period moved onto each subscription item, as `items.data[].current_period_end`. Reading the old place
 * returns `undefined` and silently loses every period end — the store would then compute a period from
 * its own clock and the arrangement would drift from what Stripe is actually charging for.
 *
 * The latest item's period is taken, because the arrangement ends when the last thing it pays for does.
 */
function periodEndOf(subscription: StripeObject): Date | undefined {
  const items = asObject(subscription["items"])?.["data"];
  if (!Array.isArray(items)) {
    return undefined;
  }
  let latest: Date | undefined;
  for (const item of items) {
    const end = asInstant(asObject(item)?.["current_period_end"]);
    if (end !== undefined && (latest === undefined || end.getTime() > latest.getTime())) {
      latest = end;
    }
  }
  return latest;
}

/** Header lookup that does not depend on the case the runtime happened to give us. */
function headerOf(delivery: RawProviderDelivery, name: string): string | undefined {
  const direct = delivery.headers[name];
  if (direct !== undefined) {
    return direct;
  }
  const found = Object.entries(delivery.headers).find(([key]) => key.toLowerCase() === name);
  return found?.[1];
}
