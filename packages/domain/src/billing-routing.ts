/**
 * Who sells, through whom, in what currency — and what any of it is allowed to activate (#46, ADR-019).
 *
 * Four separate ideas, which the product has to keep separate because the market does.
 *
 * **The payment provider and the selling legal entity are not the same choice.** A direct processor leaves
 * us the seller of record; a Merchant of Record *is* the seller to the customer and remits the tax. The
 * same provider can be used by two seller entities and the same entity through two providers, so a
 * `SellerProfile` and a `BillingRoute` are different rows and a route names one of each.
 *
 * **Providers differ, and pretending otherwise is how a product ships a lie.** A route declares
 * capabilities; nothing assumes recurring subscriptions, proration, invoices or tax remittance. Tax
 * *calculation* and tax *remittance* are two capabilities on purpose — a processor that can work out VAT
 * is not thereby the Merchant of Record for it.
 *
 * **Different payment models normalize into one entitlement layer.** A provider-managed recurring
 * subscription and a settled prepaid term both grant service; the difference is whether a renewal may be
 * assumed, so `RECURRING` and `PREPAID_TERM` are the two arrangement kinds and a prepaid term always
 * carries an explicit end.
 *
 * **Money is never a float, and a quote is never a price change.** Amounts are whole minor units of a
 * named currency or asset. The catalogue may price a plan in EUR while a crypto route quotes the same plan
 * in an asset for fifteen minutes; the quote records what was asked for and settles or does not, and the
 * plan's meaning is untouched either way.
 *
 * Nothing here reads a clock, a database or a provider. Route admission, quote arithmetic and the
 * activation rule are all decisions, and a decision that cannot be tested on its own is one nobody
 * trusts. The *enforcement* of "only a verified event activates" lives where the writes are
 * (`packages/db/src/billing-events.ts`); what lives here is the rule it enforces.
 */
import { literalGuard } from "./enum";
import { DomainValidationError } from "./errors";
import { canonicalLanguageTag } from "./language";

/**
 * What a billing provider can actually do, in the product's own words.
 *
 * A closed list, because the point of the list is that a route cannot claim a capability nobody wrote
 * down and no code consults. Each name answers a question some path genuinely asks:
 *
 * - `RECURRING_SUBSCRIPTIONS` / `PREPAID_TERM` — which arrangement kinds this route can drive at all.
 * - `REFUNDS` / `DISPUTES` — whether a reversal can be initiated here, and whether the provider will tell
 *   us about one raised against us.
 * - `TAX_CALCULATION` / `TAX_REMITTANCE` — separate, and the separation is the whole reason this list is
 *   not a boolean called `isMoR`. Remittance is what makes a route a Merchant of Record.
 * - `INVOICES` / `CUSTOMER_PORTAL` — whether the provider issues the document and hosts the self-service
 *   screens, or whether we owe the customer both.
 * - `VERIFIED_WEBHOOKS` / `AUTHORITATIVE_RECONCILIATION` — the two ways a payment can become a fact. A
 *   route with neither could never activate anything, which is why an enabled route must have one.
 * - `PRORATION` — whether a mid-term plan change can be charged for by the provider rather than waited out.
 * - `MULTI_CURRENCY` — whether more than one of the route's currencies can be charged, or only its first.
 * - `TIMED_QUOTES` — whether a charge is a time-bounded quote in another asset rather than a fixed price.
 *   Crypto needs this; a card processor does not have it and does not need it.
 */
export const BILLING_CAPABILITIES = [
  "RECURRING_SUBSCRIPTIONS",
  "PREPAID_TERM",
  "REFUNDS",
  "DISPUTES",
  "TAX_CALCULATION",
  "TAX_REMITTANCE",
  "INVOICES",
  "CUSTOMER_PORTAL",
  "VERIFIED_WEBHOOKS",
  "AUTHORITATIVE_RECONCILIATION",
  "PRORATION",
  "MULTI_CURRENCY",
  "TIMED_QUOTES",
] as const;
export type BillingCapability = (typeof BILLING_CAPABILITIES)[number];
export const isBillingCapability = literalGuard(BILLING_CAPABILITIES);

/**
 * Who the customer's money legally reaches, and who owes the tax on it.
 *
 * Not a provider name and not a jurisdiction: those are configuration. This is the one thing about a route
 * the product itself has to reason about, because it decides whose invoice the customer receives and
 * whether a tax number of ours appears on it.
 */
export const SETTLEMENT_MODELS = ["DIRECT_PSP", "MERCHANT_OF_RECORD", "CRYPTO_PROCESSOR"] as const;
export type SettlementModel = (typeof SETTLEMENT_MODELS)[number];
export const isSettlementModel = literalGuard(SETTLEMENT_MODELS);

/**
 * How service is paid for over time.
 *
 * `RECURRING` is a provider-managed subscription: the provider will charge again and tell us. A
 * `PREPAID_TERM` is a settled payment that buys service until a stated date and nothing more — no renewal
 * is assumed, because assuming one is how a product quietly keeps serving a customer who never agreed to
 * pay again. The two normalize into the same entitlement, which is the point.
 */
export const ARRANGEMENT_KINDS = ["RECURRING", "PREPAID_TERM"] as const;
export type ArrangementKind = (typeof ARRANGEMENT_KINDS)[number];
export const isArrangementKind = literalGuard(ARRANGEMENT_KINDS);

/** Which arrangement kind a capability enables. One pair, written once, so the two cannot drift. */
const ARRANGEMENT_CAPABILITY: Readonly<Record<ArrangementKind, BillingCapability>> = {
  RECURRING: "RECURRING_SUBSCRIPTIONS",
  PREPAID_TERM: "PREPAID_TERM",
};

/** How often a charge recurs. The catalogue's own intervals; `ONE_TIME` is a top-up, never an arrangement. */
export const CHARGE_INTERVALS = ["MONTH", "YEAR"] as const;
export type ChargeInterval = (typeof CHARGE_INTERVALS)[number];
export const isChargeInterval = literalGuard(CHARGE_INTERVALS);

/**
 * The two ways a payment becomes a fact the product will act on.
 *
 * A browser arriving at a success page is neither of them, and that is the entire reason this type is
 * written out: a redirect is a statement by the customer's browser about what the customer's browser was
 * told, and an entitlement granted on it is an entitlement anybody can grant themselves.
 */
export const ACTIVATION_SOURCES = ["VERIFIED_EVENT", "RECONCILIATION"] as const;
export type ActivationSource = (typeof ACTIVATION_SOURCES)[number];
export const isActivationSource = literalGuard(ACTIVATION_SOURCES);

/** Which capability makes each activation source available. */
const ACTIVATION_CAPABILITY: Readonly<Record<ActivationSource, BillingCapability>> = {
  VERIFIED_EVENT: "VERIFIED_WEBHOOKS",
  RECONCILIATION: "AUTHORITATIVE_RECONCILIATION",
};

/**
 * One configured way to take money, as the product sees it.
 *
 * Deliberately without the provider's account identifier, API keys or tax configuration: those are
 * infrastructure, they are secrets or they are opaque, and none of them is something a routing decision
 * may consult. What is here is what a decision needs — and `routeId` is a stored row's identity, never a
 * value a request supplied.
 */
export interface BillingRouteTerms {
  readonly routeId: string;
  /** Operator-facing code, for an error message a human has to act on. */
  readonly code: string;
  readonly settlementModel: SettlementModel;
  readonly capabilities: readonly BillingCapability[];
  /**
   * The catalogue currencies this route can take a charge for. Never empty.
   *
   * The *base* currency, not the settlement asset. A plan is priced in ISO 4217 and stays priced in it; a
   * route with `TIMED_QUOTES` may settle an EUR-priced charge in another asset, and which asset that is
   * belongs to the quote rather than to routing. Keeping it that way is what stops a crypto route from
   * needing a parallel price book, which is exactly the "the quote does not rewrite the plan's meaning"
   * clause of ADR-019.
   */
  readonly currencies: readonly string[];
  readonly intervals: readonly ChargeInterval[];
  /** ISO 3166-1 alpha-2 markets this route may be used for. Empty means unrestricted. */
  readonly markets: readonly string[];
  /** Whether the operator has turned this route on. A disabled route admits nothing. */
  readonly enabled: boolean;
  /** Order of preference among routes that all admit a request. Lower wins. */
  readonly priority: number;
}

/** Whether this route declares a capability. */
export function routeSupports(route: BillingRouteTerms, capability: BillingCapability): boolean {
  return route.capabilities.includes(capability);
}

/**
 * Who remits the tax on a charge taken through this route.
 *
 * Read from the capability rather than from the settlement model, so that the one hard rule — a Merchant
 * of Record remits — is stated once, in `settlementModelCoherent`, instead of being re-derived here where
 * a mismatch would silently resolve in favour of whichever field was read.
 */
export function taxRemittedBy(route: BillingRouteTerms): "PROVIDER" | "SELLER" {
  return routeSupports(route, "TAX_REMITTANCE") ? "PROVIDER" : "SELLER";
}

/** The arrangement kinds this route can actually drive. */
export function arrangementsOf(route: BillingRouteTerms): readonly ArrangementKind[] {
  return ARRANGEMENT_KINDS.filter((kind) => routeSupports(route, ARRANGEMENT_CAPABILITY[kind]));
}

/** The ways a payment on this route could ever become a fact. Empty means the route can activate nothing. */
export function activationSourcesOf(route: BillingRouteTerms): readonly ActivationSource[] {
  return ACTIVATION_SOURCES.filter((source) => routeSupports(route, ACTIVATION_CAPABILITY[source]));
}

/**
 * Why a configured route is not a coherent route.
 *
 * Checked in the domain *and* by CHECK constraints on the table, deliberately. The constraint is what
 * makes an incoherent row impossible; this is what tells the operator which of the eleven capability
 * checkboxes they got wrong, which a constraint violation does not.
 */
export const ROUTE_INCOHERENCES = [
  /** A Merchant of Record that does not remit tax is not a Merchant of Record. */
  "MOR_WITHOUT_TAX_REMITTANCE",
  /** A crypto processor charges a time-bounded quote in an asset; without quotes it is a card processor. */
  "CRYPTO_WITHOUT_QUOTES",
  /** A route that can drive neither a subscription nor a prepaid term can sell nothing. */
  "NO_ARRANGEMENT",
  /** Nothing on this route could ever become a fact, so it could never activate an entitlement. */
  "NO_ACTIVATION_SOURCE",
  /** More than one currency on a route that cannot charge in more than one. */
  "MULTI_CURRENCY_UNDECLARED",
  /** No currency, no interval: a route that admits nothing is a configuration mistake, not a policy. */
  "EMPTY_TERMS",
] as const;
export type RouteIncoherence = (typeof ROUTE_INCOHERENCES)[number];

/**
 * Everything wrong with a route's configuration, as a list rather than the first fault.
 *
 * An operator fixing a route wants all of it at once; returning one reason at a time turns one
 * configuration mistake into four round trips.
 */
export function settlementModelCoherent(route: BillingRouteTerms): readonly RouteIncoherence[] {
  const faults: RouteIncoherence[] = [];
  if (route.settlementModel === "MERCHANT_OF_RECORD" && !routeSupports(route, "TAX_REMITTANCE")) {
    faults.push("MOR_WITHOUT_TAX_REMITTANCE");
  }
  if (route.settlementModel === "CRYPTO_PROCESSOR" && !routeSupports(route, "TIMED_QUOTES")) {
    faults.push("CRYPTO_WITHOUT_QUOTES");
  }
  if (arrangementsOf(route).length === 0) {
    faults.push("NO_ARRANGEMENT");
  }
  if (activationSourcesOf(route).length === 0) {
    faults.push("NO_ACTIVATION_SOURCE");
  }
  if (route.currencies.length > 1 && !routeSupports(route, "MULTI_CURRENCY")) {
    faults.push("MULTI_CURRENCY_UNDECLARED");
  }
  if (route.currencies.length === 0 || route.intervals.length === 0) {
    faults.push("EMPTY_TERMS");
  }
  return faults;
}

/** What a checkout is asking for, in product terms. No provider, no account, no seller: those are ours. */
export interface RouteRequest {
  readonly arrangement: ArrangementKind;
  readonly interval: ChargeInterval;
  /** The catalogue currency the plan is priced in. A quote may settle it in another asset. */
  readonly currency: string;
  /** ISO 3166-1 alpha-2, where the product knows it. Absent means no market restriction can be applied. */
  readonly market?: string;
}

/** Why a route refused a request. One reason per route, which is what an operator needs to see. */
export const ROUTE_REFUSALS = [
  "ROUTE_DISABLED",
  "ROUTE_INCOHERENT",
  "ARRANGEMENT_UNSUPPORTED",
  "INTERVAL_UNSUPPORTED",
  "CURRENCY_UNSUPPORTED",
  "MARKET_UNSUPPORTED",
] as const;
export type RouteRefusal = (typeof ROUTE_REFUSALS)[number];

export type RouteAdmission = { readonly admitted: true } | { readonly admitted: false; readonly refusal: RouteRefusal };

const ADMITTED: RouteAdmission = { admitted: true };

/**
 * Whether this route may be used for this request.
 *
 * Order matters only for which reason is reported, and it goes from the operator's fault to the customer's
 * circumstances: a disabled or incoherent route is something somebody has to fix, while an unsupported
 * currency is a fact about this request.
 *
 * A route with no `markets` is unrestricted; a request with no market is admitted by a *restricted* route
 * too. That is deliberate and worth saying out loud: the market is used to prefer a route, not to prove a
 * customer's residence, and refusing a checkout because the product had not geolocated anybody would make
 * the restriction a gate on information we do not have.
 */
export function routeAdmits(route: BillingRouteTerms, request: RouteRequest): RouteAdmission {
  if (!route.enabled) {
    return { admitted: false, refusal: "ROUTE_DISABLED" };
  }
  if (settlementModelCoherent(route).length > 0) {
    return { admitted: false, refusal: "ROUTE_INCOHERENT" };
  }
  if (!arrangementsOf(route).includes(request.arrangement)) {
    return { admitted: false, refusal: "ARRANGEMENT_UNSUPPORTED" };
  }
  if (!route.intervals.includes(request.interval)) {
    return { admitted: false, refusal: "INTERVAL_UNSUPPORTED" };
  }
  if (!route.currencies.includes(request.currency)) {
    return { admitted: false, refusal: "CURRENCY_UNSUPPORTED" };
  }
  if (request.market !== undefined && route.markets.length > 0 && !route.markets.includes(request.market)) {
    return { admitted: false, refusal: "MARKET_UNSUPPORTED" };
  }
  return ADMITTED;
}

export type RouteSelection =
  | { readonly selected: true; readonly route: BillingRouteTerms }
  | { readonly selected: false; readonly refusals: readonly { readonly code: string; readonly refusal: RouteRefusal }[] };

/**
 * Picks the route for a request out of the operator's configuration.
 *
 * The whole function is the answer to "never trust a client-supplied provider, account or seller
 * identifier": there is no parameter in which one could arrive. A checkout names a plan, an interval and a
 * currency — product facts the customer is entitled to choose — and the route is read from configuration
 * the customer cannot write.
 *
 * On failure every route's reason is returned rather than a single "no route available", because the
 * person who has to act on it is an operator looking at six routes and wondering which one they
 * misconfigured.
 */
export function selectRoute(routes: readonly BillingRouteTerms[], request: RouteRequest): RouteSelection {
  const refusals: { readonly code: string; readonly refusal: RouteRefusal }[] = [];
  let best: BillingRouteTerms | undefined;
  for (const route of routes) {
    const admission = routeAdmits(route, request);
    if (!admission.admitted) {
      refusals.push({ code: route.code, refusal: admission.refusal });
      continue;
    }
    // Lowest priority wins, and a tie is broken by code so that two equally-preferred routes do not
    // depend on the order rows came back in — a checkout that lands on a different seller entity on
    // Tuesday is not a preference, it is a bug nobody can reproduce.
    if (best === undefined || route.priority < best.priority || (route.priority === best.priority && route.code < best.code)) {
      best = route;
    }
  }
  return best === undefined ? { selected: false, refusals } : { selected: true, route: best };
}

/**
 * An amount of money, as a whole number of the smallest unit of a named currency or asset.
 *
 * Minor units and nothing else. 19.99 EUR is `1999`, and the reason it is not `19.99` is that a price a
 * customer was charged has to be reproducible years later from the row that recorded it, which a binary
 * fraction of a decimal amount is not. Assets with more than two decimal places are counted in their own
 * smallest unit by the adapter that quoted them; this type does not need to know how many places that is,
 * only that the number is whole.
 */
export interface Money {
  readonly amountMinor: number;
  /** ISO 4217 or a payment-asset code, upper case. */
  readonly currency: string;
}

/** ISO 4217 is three letters; payment assets are longer and may carry digits. Upper case either way. */
const CURRENCY_PATTERN = /^[A-Z][A-Z0-9]{2,11}$/;

/** Whether a string is a usable currency or payment-asset code. The CHECK on the tables says the same. */
export function isCurrencyCode(value: string): boolean {
  return CURRENCY_PATTERN.test(value);
}

/**
 * Builds an amount, refusing everything that is not money.
 *
 * A fraction is refused rather than rounded: a caller that produced 1999.5 minor units has divided
 * something it should not have, and rounding it here would make the mistake arrive as a price. Negative is
 * refused too — a refund is a direction, recorded by the event kind, not a negative price.
 */
export function money(amountMinor: number, currency: string): Money {
  if (!Number.isInteger(amountMinor)) {
    throw new DomainValidationError("amountMinor", "money is a whole number of minor units");
  }
  if (amountMinor < 0) {
    throw new DomainValidationError("amountMinor", "money is not negative; a reversal is an event kind");
  }
  if (!isCurrencyCode(currency)) {
    throw new DomainValidationError("currency", `not a currency or payment-asset code: ${currency}`);
  }
  return { amountMinor, currency };
}

/** Whether two amounts are the same money. Currency included, because 1999 of what is the question. */
export function sameMoney(left: Money, right: Money): boolean {
  return left.currency === right.currency && left.amountMinor === right.amountMinor;
}

/**
 * A time-bounded offer to settle a charge in another currency or asset (ADR-019).
 *
 * `base` is the catalogue's own price and never changes; `charge` is what this quote asks for, in the
 * asset the route can take. The two are both kept because a settlement has to be checkable against what
 * was asked for, while an invoice and a plan's meaning refer to the base — a plan does not become cheaper
 * because an asset moved between the quote and the block it settled in.
 */
export interface PaymentQuote {
  readonly base: Money;
  readonly charge: Money;
  readonly quotedAt: Date;
  /**
   * After this instant the quoted rate is no longer an offer anybody made.
   *
   * Absent for a charge with no clock on it — a fixed catalogue price in the catalogue's own currency,
   * which is the ordinary card case. The type covers both because the amount check is the same question
   * for both, and a separate "did they pay enough?" path for unquoted charges is a second answer to it.
   */
  readonly expiresAt?: Date;
}

/**
 * What a quote's settlement amounts to.
 *
 * `SETTLED` is the only verdict that may activate anything, and the other four exist so that the reason it
 * did not is recorded instead of inferred:
 *
 * - `UNDERPAID` — less arrived than was asked for. Not activated, not discarded: the money is the
 *   customer's and a person has to decide between a top-up and a refund.
 * - `EXPIRED` — the window closed with nothing settled.
 * - `AMBIGUOUS` — enough arrived, but after the window closed. The rate it was priced at is no longer the
 *   rate, so this is the one case that looks like success and is not: it needs reconciliation by somebody
 *   who can see both sides, not an automatic grant.
 * - `PENDING` — the window is open and nothing has arrived.
 *
 * An overpayment settles. Refusing service to a customer who sent too much would be absurd; the excess is
 * a refund somebody owes, recorded as one.
 */
export const QUOTE_VERDICTS = ["SETTLED", "UNDERPAID", "EXPIRED", "AMBIGUOUS", "PENDING"] as const;
export type QuoteVerdict = (typeof QUOTE_VERDICTS)[number];
export const isQuoteVerdict = literalGuard(QUOTE_VERDICTS);

/**
 * Judges a quote against what actually arrived.
 *
 * `settled` absent means nothing has arrived yet. `at` is the instant the judgement is being made, which
 * is not the same as the instant money arrived: a settlement that reached us inside the window is settled
 * even if the webhook is read an hour later, so expiry is measured against the *settlement*, and only the
 * empty case is measured against now.
 */
export function quoteVerdict(quote: PaymentQuote, settled: { readonly amount: Money; readonly at: Date } | undefined, at: Date): QuoteVerdict {
  const expired = (instant: Date): boolean => quote.expiresAt !== undefined && instant.getTime() > quote.expiresAt.getTime();
  if (settled === undefined) {
    return expired(at) ? "EXPIRED" : "PENDING";
  }
  if (settled.amount.currency !== quote.charge.currency) {
    // Paid in something nobody quoted. Not underpayment and not success: there is no exchange rate here
    // that the product is entitled to invent.
    return "AMBIGUOUS";
  }
  if (settled.amount.amountMinor < quote.charge.amountMinor) {
    return "UNDERPAID";
  }
  return expired(settled.at) ? "AMBIGUOUS" : "SETTLED";
}

/**
 * When a term bought now ends.
 *
 * Calendar arithmetic rather than a fixed number of days, because a month is what the customer thinks
 * they bought and 30 days is not one. The day of month is clamped, so a term started on the 31st ends on
 * the 30th of a thirty-day month and on the 28th or 29th of February — which is the convention every
 * billing provider uses, and the alternative is a term that silently rolls into the next month.
 *
 * UTC throughout. A period boundary that moved with a viewer's time zone would end a paid term an hour
 * early for somebody.
 */
export function periodEndFor(interval: ChargeInterval, from: Date): Date {
  const year = from.getUTCFullYear() + (interval === "YEAR" ? 1 : 0);
  const month = from.getUTCMonth() + (interval === "MONTH" ? 1 : 0);
  // Day 0 of the following month is the last day of the target month, which is how the clamp is done
  // without a table of month lengths.
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(year, month, Math.min(from.getUTCDate(), lastDay), from.getUTCHours(), from.getUTCMinutes(), from.getUTCSeconds(), from.getUTCMilliseconds()),
  );
}

/**
 * A payment, as the product understands it after an adapter has normalized it.
 *
 * The kinds are the lifecycle every provider class has to fit into, whatever it calls them. Refunds,
 * chargebacks and cancellations are in the same list as settlements because they are the same lifecycle
 * seen from the other end — and routing them through one list is what stops a reversal being handled by
 * whichever branch of whichever adapter happened to notice it.
 */
export const BILLING_EVENT_KINDS = [
  "PAYMENT_SETTLED",
  "PAYMENT_FAILED",
  "PAYMENT_UNDERPAID",
  "QUOTE_EXPIRED",
  "SUBSCRIPTION_RENEWED",
  "SUBSCRIPTION_CANCELED",
  "REFUNDED",
  "CHARGEBACK",
] as const;
export type BillingEventKind = (typeof BILLING_EVENT_KINDS)[number];
export const isBillingEventKind = literalGuard(BILLING_EVENT_KINDS);

/**
 * What an event does to a paid entitlement.
 *
 * `ACTIVATE` and `EXTEND` are separated because they are different writes — one starts an arrangement and
 * one moves its end date — and because a renewal arriving for an arrangement that was never activated is a
 * reordering the store has to notice rather than treat as a start.
 */
export const ENTITLEMENT_EFFECTS = ["ACTIVATE", "EXTEND", "SUSPEND", "END", "NONE"] as const;
export type EntitlementEffect = (typeof ENTITLEMENT_EFFECTS)[number];

/**
 * What one normalized event is allowed to do, before anything is looked up.
 *
 * Written as a total map rather than a switch so that adding an event kind is a type error here instead of
 * a silent `NONE` somewhere — a new provider event that quietly did nothing is the failure mode this list
 * exists to prevent.
 */
const EFFECTS: Readonly<Record<BillingEventKind, EntitlementEffect>> = {
  PAYMENT_SETTLED: "ACTIVATE",
  SUBSCRIPTION_RENEWED: "EXTEND",
  // Failure and underpayment suspend rather than end: the customer keeps their data and their
  // configuration, and the spec is explicit that nothing is deleted to satisfy a commercial limit.
  PAYMENT_FAILED: "SUSPEND",
  PAYMENT_UNDERPAID: "NONE",
  QUOTE_EXPIRED: "NONE",
  SUBSCRIPTION_CANCELED: "END",
  REFUNDED: "END",
  CHARGEBACK: "END",
};

/**
 * What this event does, given the route it arrived on and the quote it refers to.
 *
 * The quote is judged here rather than trusted from the event, because "settled" is a provider's word for
 * the money arriving and `SETTLED` is the product's word for the money arriving *in time and in full*. An
 * adapter reporting `PAYMENT_SETTLED` for an underpaid or expired quote is not lying — it is reporting its
 * own vocabulary — and this is where the two meet.
 */
export function entitlementEffectOf(input: {
  readonly kind: BillingEventKind;
  readonly route: BillingRouteTerms;
  readonly quote?: PaymentQuote;
  readonly settled?: { readonly amount: Money; readonly at: Date };
  readonly at: Date;
}): { readonly effect: EntitlementEffect; readonly quote?: QuoteVerdict } {
  // A route that can neither verify an event nor reconcile authoritatively cannot make anything true, so
  // nothing arriving on it may act. Reached only through misconfiguration, and refused rather than trusted.
  if (activationSourcesOf(input.route).length === 0) {
    return { effect: "NONE" };
  }
  if (input.quote === undefined) {
    return { effect: EFFECTS[input.kind] };
  }
  const verdict = quoteVerdict(input.quote, input.settled, input.at);
  if (input.kind !== "PAYMENT_SETTLED" && input.kind !== "SUBSCRIPTION_RENEWED") {
    return { effect: EFFECTS[input.kind], quote: verdict };
  }
  return { effect: verdict === "SETTLED" ? EFFECTS[input.kind] : "NONE", quote: verdict };
}

/**
 * The legal documents a checkout may have to be accepted against (ADR-019, #47).
 *
 * Separate kinds rather than one "terms" blob because they are versioned and accepted separately in
 * practice, and because which of them a checkout requires is a product and jurisdiction decision that the
 * owner has not made yet. What is fixed here is that each is versioned and each acceptance is recorded.
 *
 * `REFUND_POLICY` is a kind rather than a paragraph inside the offer because #47 asks for it to be
 * *linked* where product configuration requires it — which means it has to be a document with a version
 * of its own, and a document that is linked rather than ticked is simply one whose
 * `required_for_checkout` is false. Both behaviours therefore fall out of the same two columns.
 */
export const LEGAL_DOCUMENT_KINDS = ["TERMS_OF_SERVICE", "PUBLIC_OFFER", "PRIVACY_POLICY", "REFUND_POLICY"] as const;
export type LegalDocumentKind = (typeof LEGAL_DOCUMENT_KINDS)[number];
export const isLegalDocumentKind = literalGuard(LEGAL_DOCUMENT_KINDS);

/**
 * Which required documents a checkout is still missing an acceptance of.
 *
 * Returns the kinds rather than a boolean because the screen has to say which box was not ticked, and
 * because "incomplete" is not a sentence anybody can act on. The database enforces the same rule with a
 * deferred constraint trigger, so a contract written by anything other than this path still cannot commit
 * without its acceptances; this is what produces the message before it gets that far.
 */
export function missingAcceptances(
  required: readonly LegalDocumentKind[],
  accepted: readonly LegalDocumentKind[],
): readonly LegalDocumentKind[] {
  return LEGAL_DOCUMENT_KINDS.filter((kind) => required.includes(kind) && !accepted.includes(kind));
}

/**
 * Which published locale of a document to show somebody who asked for another one (#47).
 *
 * This exists because the alternative is worse than it looks. Filtering documents by an exact locale
 * means a workspace whose interface is in a language the offer has not been translated into is shown *no
 * terms at all* — and a checkout screen with nothing to tick is not a stricter checkout, it is one whose
 * acceptance control has silently disappeared. The database's own acceptance trigger does not filter by
 * locale, so the two then disagree and the checkout dies on a constraint instead of saying anything.
 *
 * The order is the one a reader would want: the exact tag, then the same language in another region, then
 * the fallback the product publishes everything in. `undefined` only when even the fallback is missing,
 * which means nobody has published that document at all.
 *
 * Tags are canonicalized on both sides before they meet, for the reason `language.ts` gives: `en-us` and
 * `EN-US` are the same tag, and an equality comparison between two spellings of it misses.
 */
export function negotiateDocumentLocale(requested: string, available: readonly string[], fallback: string): string | undefined {
  const canonical = (tag: string): string | undefined => canonicalLanguageTag(tag) ?? undefined;
  const published = available.flatMap((tag) => {
    const value = canonical(tag);
    return value === undefined ? [] : [{ original: tag, canonical: value, language: languageOf(value) }];
  });
  const wanted = canonical(requested);
  if (wanted !== undefined) {
    const exact = published.find((entry) => entry.canonical === wanted);
    if (exact !== undefined) {
      return exact.original;
    }
    const language = languageOf(wanted);
    // Same language, another region: `ru-RU` reads `ru`, and a Brazilian reader reads Portuguese. Only
    // after that does the fallback apply, because an untranslated tag is not the same as an unknown one.
    const sameLanguage = published.find((entry) => entry.language === language);
    if (sameLanguage !== undefined) {
      return sameLanguage.original;
    }
  }
  const fallbackLanguage = languageOf(canonical(fallback) ?? fallback);
  return published.find((entry) => entry.language === fallbackLanguage)?.original;
}

function languageOf(tag: string): string {
  return (tag.split("-")[0] ?? tag).toLowerCase();
}

/**
 * Whether the person was shown the document in the language their interface was in (#47).
 *
 * Recorded on the acceptance rather than inferred, because the question a dispute actually asks is "was
 * this person shown terms in a language they read?" — and the answer is not derivable from the document
 * row, which only knows what language *it* is in. A `true` here and a `false` there are both acceptable
 * states of the world; what is not acceptable is not knowing which happened.
 */
export function acceptedInOwnLanguage(viewerLocale: string, documentLocale: string): boolean {
  const viewer = canonicalLanguageTag(viewerLocale) ?? viewerLocale;
  const document = canonicalLanguageTag(documentLocale) ?? documentLocale;
  return languageOf(viewer) === languageOf(document);
}
