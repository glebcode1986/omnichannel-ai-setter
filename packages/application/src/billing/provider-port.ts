/**
 * The only two ways a payment becomes a fact (#46, ADR-017, ADR-019).
 *
 * Here, in `application`, because ADR-017 says so in as many words: "application owns billing/entitlement
 * use cases and provider-neutral ports; billing provider adapter/infrastructure implements those ports".
 * It was first written inside `packages/db` next to the store that consumes it, which read naturally and
 * made the first adapter impossible: an adapter package may depend on the core packages, and a payment
 * provider adapter that had to import the persistence package in order to name the interface it
 * implements would be the wrong dependency in the one place the architecture is strictest about. The same
 * arrangement ADR-010 already uses for `ReplyModel` — port in `application`, implementation in
 * `packages/ai`.
 *
 * The rule this file exists for is one sentence long: **a browser arriving at a success page never
 * activates a paid entitlement.** A redirect is a statement by the customer's browser about what the
 * customer's browser was told, and an entitlement granted on one is an entitlement anybody can grant
 * themselves by visiting a URL.
 *
 * Stating that as a rule is not enough, because the shape of the mistake is a handler that looks correct:
 * the `/billing/success` route has a workspace, it has a plan, it has every field it needs, and all it is
 * missing is authority nobody noticed it did not have. So the rule is structural instead.
 *
 * `recordVerifiedBillingEvent` takes a `VerifiedBillingEvent`, and the only values of that type are the
 * objects this module mints — tracked in a module-private `WeakMap` that holds each one's authenticated
 * facts, in the spirit of how `tenancy.ts` tracks the contexts it issued. A map rather than a set because
 * an event can be altered after minting without changing its identity: `Object.freeze` is shallow, a
 * `Date` is mutable whatever is done to the object holding it, and a membership test cannot see either.
 * `isMintedBillingEvent` therefore recomputes the facts and compares. Minting happens in two functions
 * and both go through a registered provider adapter: `verifyProviderDelivery`, which hands the adapter a
 * raw signed delivery to authenticate, and `reconcileProviderState`, which asks the adapter what the
 * provider itself says is true. A caller with a plan identifier and good intentions has no way to produce
 * one, and a structural type assertion does not help them: the map is not reachable, the objects are
 * frozen, their nested money and dates are snapshots rather than the adapter's own, and an edit after
 * minting makes the check fail rather than pass.
 *
 * Nothing here parses a provider's payload, and nothing here holds a secret. The adapter owns signature
 * verification and raw parsing, and what crosses this line is normalized and provider-neutral — which is
 * also why no raw payload, signature or header reaches the `billing_events` row.
 */
import type { BillingEventKind, Money } from "@omnichannel/domain";
import { isBillingEventKind, isCurrencyCode, type ActivationSource } from "@omnichannel/domain";

/**
 * A payment as the product understands it, after an adapter has normalized it.
 *
 * `routeCode` rather than a route id: an adapter knows which of its configured accounts a delivery
 * arrived for, and resolving that to a row is this side's job. Everything optional is optional because
 * some provider class genuinely does not have it — a crypto settlement has no subscription to renew, a
 * renewal has no checkout to point at.
 */
export interface NormalizedBillingEvent {
  readonly routeCode: string;
  /** The provider's own event identifier. Opaque, and what idempotency is keyed on. */
  readonly providerEventId: string;
  readonly kind: BillingEventKind;
  readonly occurredAt: Date;
  /** The checkout this event answers, where the provider can say which one. */
  readonly checkoutContractId?: string;
  /** The arrangement this event concerns, for a renewal, a cancellation or a reversal. */
  readonly arrangementId?: string;
  /** What actually moved. Absent for an event about no money. */
  readonly settled?: Money;
  /** When the money moved, where that differs from when the event was raised. */
  readonly settledAt?: Date;
  /** The end of the period this payment bought, where the provider states one. */
  readonly periodEndsAt?: Date;
  /** The provider's own subscription or charge object, opaque, for reconciliation. */
  readonly providerReference?: string;
}

/**
 * A normalized event that an adapter has authenticated, or that the provider itself asserted.
 *
 * The brand is not a convention. There is no exported way to put one of these together by hand, and
 * casting to the type does not produce one — `recordVerifiedBillingEvent` checks the event against the
 * authenticated facts this module recorded for it, in a map it never exposes.
 */
export type VerifiedBillingEvent = NormalizedBillingEvent & {
  readonly activationSource: ActivationSource;
};

const mintedEvents = new WeakMap<object, string>();

/**
 * The authenticated facts of an event, as one string.
 *
 * Every field a downstream decision reads: the identity of the event, what it says happened, when, to
 * which arrangement, and for how much until when. An edit to any of them produces a different value, so
 * the object is no longer the event that was authenticated.
 */
function fingerprint(event: VerifiedBillingEvent): string {
  const at = (value: Date | undefined): string => (value === undefined ? "-" : String(value.getTime()));
  return [
    event.routeCode,
    event.providerEventId,
    event.kind,
    event.activationSource,
    at(event.occurredAt),
    event.checkoutContractId ?? "-",
    event.arrangementId ?? "-",
    event.settled === undefined ? "-" : String(event.settled.amountMinor),
    event.settled === undefined ? "-" : event.settled.currency,
    at(event.settledAt),
    at(event.periodEndsAt),
    event.providerReference ?? "-",
  ].join("\u0000");
}

/**
 * A copy that shares nothing mutable with whoever held the original.
 *
 * `Object.freeze` is shallow, so a frozen event still hands out the adapter's own `Date` objects and its
 * own money object. Copying them is what makes the frozen shell mean anything.
 */
function snapshot(event: VerifiedBillingEvent): VerifiedBillingEvent {
  return Object.freeze({
    ...event,
    occurredAt: new Date(event.occurredAt.getTime()),
    ...(event.settled === undefined ? {} : { settled: Object.freeze({ amountMinor: event.settled.amountMinor, currency: event.settled.currency }) }),
    ...(event.settledAt === undefined ? {} : { settledAt: new Date(event.settledAt.getTime()) }),
    ...(event.periodEndsAt === undefined ? {} : { periodEndsAt: new Date(event.periodEndsAt.getTime()) }),
  });
}

/** A raw delivery, exactly as it arrived. Only an adapter looks inside it. */
export interface RawProviderDelivery {
  /** Which adapter this is for. Matched against a registered adapter's own name. */
  readonly provider: string;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  /** When the product received it, for the audit trail. */
  readonly receivedAt: Date;
}

/** What a reconciliation run asks the provider about. */
export interface ReconciliationQuery {
  readonly routeCode: string;
  /** The provider's own object to ask about: a checkout session, a subscription, a charge. */
  readonly providerReference: string;
}

/**
 * What an adapter wants replied to the provider, when the provider requires an acknowledgement.
 *
 * Some providers treat the HTTP response to their callback as part of the protocol rather than as
 * transport: WayForPay expects a signed body and retries the delivery when it does not get one. Only the
 * adapter can produce that body, because only the adapter holds the signing secret — so the port carries
 * it back rather than leaving the route to invent a reply. `undefined` means the provider needs nothing
 * beyond a success status, which is the common case.
 *
 * No status code: whether the delivery was accepted is this side's decision and not the adapter's, and an
 * adapter able to choose the status could answer `200` to a delivery the product refused.
 */
export interface ProviderAcknowledgement {
  readonly body: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * What an adapter makes of a delivery it has authenticated.
 *
 * Three answers, not two, and the third one is why this is a union. A provider sends every event type its
 * endpoint is subscribed to, and some of them are authentic and mean nothing to this product — Stripe
 * raises an event when a payment method is attached, and a subscription integration has nothing to do
 * with it. Collapsing that case into `null` would make it indistinguishable from a forgery, and the two
 * owe the provider opposite replies: a forgery is refused, while an authentic event the product ignores
 * has to be acknowledged or the provider redelivers it for days. `null` therefore keeps one meaning only —
 * this delivery was not authentic — and `NO_EVENT` carries the other.
 *
 * The acknowledgement is on both arms because a provider that requires a signed reply requires it either
 * way: it is owed for the delivery, not for the delivery being interesting.
 */
export type VerifiedDelivery =
  | { readonly kind: "EVENT"; readonly event: NormalizedBillingEvent; readonly acknowledgement?: ProviderAcknowledgement }
  | { readonly kind: "NO_EVENT"; readonly acknowledgement?: ProviderAcknowledgement };

/**
 * How a customer is handed to the provider to pay.
 *
 * A union rather than a URL, because not every provider gives one. Stripe and a crypto invoice return a
 * link; WayForPay returns a set of fields that have to be POSTed as a form, signed. A port that assumed a
 * redirect would force every adapter that does not have one to invent a hosted page, which is the kind of
 * faking the capability list exists to prevent.
 */
export type CheckoutHandoff =
  | { readonly kind: "REDIRECT"; readonly url: string; readonly reference?: string }
  | { readonly kind: "FORM_POST"; readonly action: string; readonly fields: Readonly<Record<string, string>>; readonly reference?: string };

/**
 * `reference` is the provider's own object for this hand-off, where it has one — a Stripe Checkout
 * Session id, a crypto invoice id. Opaque, and recorded against the contract write-once so that a
 * settlement can be matched back to the session it came from. Optional because a provider that returns a
 * signed form may have nothing to name yet.
 */

/**
 * What a provider adapter is asked to open a checkout for.
 *
 * Opaque references and settled amounts only: the plan version and price come from the catalogue, the
 * seller and route are resolved server-side, and `arrangement` says whether the provider is being asked
 * for a subscription it will renew or for a term that is paid once. An adapter whose provider has no
 * recurring primitive refuses `RECURRING` rather than returning something that looks like one.
 *
 * `Provider`-prefixed because `billing-routing-store.ts` has a `CheckoutRequest` of its own and the two
 * are different questions: that one is what the *product* was asked for — a plan version, an interval, a
 * market, a reader's locale — and this one is what is left after the route, the seller and the price have
 * been resolved from it. Sharing the name meant the barrel exported one of them and an adapter in another
 * package could not name the other.
 */
export interface ProviderCheckoutRequest {
  readonly routeCode: string;
  readonly arrangement: "RECURRING" | "PREPAID_TERM";
  readonly amountMinor: number;
  readonly currency: string;
  /** The catalogue's own immutable price reference. Never a provider price id chosen by a client. */
  readonly priceReference: string;
  /** Opaque, workspace-scoped, and the only thing tying a settlement back to a customer. */
  readonly clientReference: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
}

/**
 * What a provider adapter is asked to open a self-service management session for.
 *
 * Stripe has a hosted customer portal, and the owner's P6-04 decision requires it where the provider
 * supports it. Expressed as its own optional port member rather than folded into checkout, because the two
 * are different acts: a checkout starts a charge path, and this one lets somebody already paying change
 * their payment method or cancel. An adapter whose provider has no such page simply does not implement it,
 * and the product then does not offer a link — which is the capability rule, not a special case.
 *
 * `providerReference` is the opaque reference the arrangement already stores. The adapter resolves whatever
 * the provider needs from it; nothing about a provider's customer model reaches this side.
 */
export interface ProviderManagementRequest {
  readonly routeCode: string;
  readonly providerReference: string;
  readonly returnUrl: string;
  /** The reader's own interface language, as a BCP-47 tag, where the provider can honour one. */
  readonly locale?: string;
}

/**
 * What a provider adapter is asked to do about the next renewal.
 *
 * `renew: false` ends the arrangement when the paid period runs out, and `renew: true` undoes that while
 * the period is still running. Neither is a cancellation *now*: the customer has paid for a period and
 * keeps it, which is also why this does not report an event — the provider raises one when the period
 * actually ends, and that is the only thing that may change an entitlement.
 */
export interface ProviderRenewalRequest {
  readonly routeCode: string;
  readonly providerReference: string;
  readonly renew: boolean;
}

/** What the provider says about the arrangement after the change. */
export interface ProviderRenewalState {
  /** Whether the provider will charge again at the end of the current period. */
  readonly renews: boolean;
  /** When the paid period ends, where the provider states it. */
  readonly periodEndsAt?: Date;
}

/**
 * One billing provider's adapter.
 *
 * `verify` returns `null` for anything it cannot authenticate, and that includes a payload it could parse
 * perfectly: an unsigned or wrongly-signed delivery is indistinguishable from an attacker's, and both get
 * the same answer. It may be **asynchronous**, because for some providers authentication is a round trip
 * rather than a signature check — PayPal's IPN validation asks the provider whether it sent the message —
 * and a synchronous-only port could not represent such an adapter at all.
 *
 * `reconcile` is optional because not every provider offers an authoritative read; a route whose adapter
 * has none must declare `AUTHORITATIVE_RECONCILIATION` off, and the CHECK on `billing_routes` then refuses
 * to enable it unless it has verified webhooks instead. `openCheckout` is optional for the same shape of
 * reason: a route may exist to receive settlements without this process being the one that opens them.
 */
export interface BillingProviderAdapter {
  readonly provider: string;
  readonly verify: (delivery: RawProviderDelivery) => VerifiedDelivery | null | Promise<VerifiedDelivery | null>;
  readonly reconcile?: (query: ReconciliationQuery) => Promise<NormalizedBillingEvent | null>;
  readonly openCheckout?: (request: ProviderCheckoutRequest) => Promise<CheckoutHandoff>;
  /**
   * A provider-hosted page where a paying customer manages their own arrangement.
   *
   * Optional, and absent means the product offers no such link. A capability list that claimed every
   * provider had one would make the screen promise a page that does not exist.
   */
  readonly openManagementSession?: (request: ProviderManagementRequest) => Promise<CheckoutHandoff>;
  /**
   * Stops or restarts the renewal of an arrangement the provider is charging for.
   *
   * Optional for the same reason: a provider with no recurring primitive has no renewal to stop. One that
   * has one answers with what it now says is true, so the screen reports the provider's state rather than
   * the state the request asked for.
   */
  readonly setRenewal?: (request: ProviderRenewalRequest) => Promise<ProviderRenewalState>;
}

const adapters = new Map<string, BillingProviderAdapter>();

/**
 * Registers an adapter, at a composition root.
 *
 * Replacing a registration is allowed and deliberate: a test registers a stub, and a process that
 * re-registered the same provider twice is a process that loaded its composition root twice. What is not
 * allowed is registering nothing and expecting a delivery to be trusted — an unknown provider is refused
 * by `verifyProviderDelivery`, which is the case that matters.
 */
export function registerBillingProvider(adapter: BillingProviderAdapter): void {
  if (adapter.provider.trim() === "") {
    // A programmer error at a composition root, not a request: an adapter with no name could never be
    // matched to a delivery, so registering one is a typo that would present itself as a provider whose
    // webhooks are all forgeries.
    throw new RangeError("a billing provider adapter has a name");
  }
  adapters.set(adapter.provider, adapter);
}

/** Forgets every registration. For tests, so one suite's stub cannot answer another's delivery. */
export function clearBillingProviders(): void {
  adapters.clear();
}

/**
 * Whether a provider has an adapter registered in this process.
 *
 * Asked before a checkout is opened (#47): a checkout nobody could settle would still consume the
 * workspace's single live charge path, so the honest answer is to say "not yet" on the screen rather than
 * to write a contract and leave a `PENDING` arrangement for the sweeper. Process-local, and that is the
 * right scope — the process that will hand the customer to the provider is the one being asked.
 */
export function billingProviderRegistered(provider: string): boolean {
  return adapters.has(provider);
}

/**
 * Authenticates a raw delivery and mints the verified event, or refuses.
 *
 * `null` for an unknown provider, for a delivery the adapter would not authenticate, and for a normalized
 * event that is not usable — the last case checked here rather than trusted, because an adapter is
 * third-party-shaped code and a `kind` outside the product's vocabulary would otherwise reach a column
 * and fail there, with the provider's name on a database error instead of a refusal.
 */
export async function verifyProviderDelivery(delivery: RawProviderDelivery): Promise<VerifiedProviderDelivery> {
  const adapter = adapters.get(delivery.provider);
  if (adapter === undefined) {
    return { kind: "REFUSED" };
  }
  // Awaited whether or not the adapter is asynchronous, so that a provider whose authentication is a
  // round trip is representable without a second code path. An adapter that throws is refused like one
  // that returns `null`: a verification that could not complete has not succeeded, and a thrown provider
  // outage must not reach the caller as an authenticated delivery.
  let verified: VerifiedDelivery | null;
  try {
    verified = await adapter.verify(delivery);
  } catch {
    return { kind: "REFUSED" };
  }
  if (verified === null) {
    return { kind: "REFUSED" };
  }
  const acknowledgement = verified.acknowledgement === undefined ? {} : { acknowledgement: verified.acknowledgement };
  if (verified.kind === "NO_EVENT") {
    return { kind: "ACKNOWLEDGED", ...acknowledgement };
  }
  const event = mint(verified.event, "VERIFIED_EVENT");
  if (event === null) {
    // An authentic delivery the adapter normalized into something the product cannot name. Refused rather
    // than acknowledged: the adapter believed it had a product event, so answering the provider "received
    // and handled" would discard a payment nobody will look for again.
    return { kind: "REFUSED" };
  }
  // The acknowledgement travels with the verified event rather than being fetched separately, because the
  // two are one answer: this delivery was authentic, *and* this is what the provider is owed for it.
  return { kind: "EVENT", event, ...acknowledgement };
}

/**
 * What the webhook route learned, and what the provider is owed for it.
 *
 * `REFUSED` is the only arm that must not be answered with a success status: the other two are both
 * authentic deliveries, and a provider that does not hear "received" redelivers for days. Which of the
 * two it is decides whether anything is recorded, not what the provider is told.
 */
export type VerifiedProviderDelivery =
  | { readonly kind: "EVENT"; readonly event: VerifiedBillingEvent; readonly acknowledgement?: ProviderAcknowledgement }
  | { readonly kind: "ACKNOWLEDGED"; readonly acknowledgement?: ProviderAcknowledgement }
  | { readonly kind: "REFUSED" };

/**
 * Opens a checkout with the provider configured for a route, or refuses.
 *
 * `null` for an unknown provider and for an adapter that cannot open one, which the caller must treat as
 * "not yet" on the screen rather than as a failure — the same answer `billingProviderRegistered` gives
 * before a contract is written. A provider error is not swallowed: unlike verification, where a failure
 * and a forgery must be indistinguishable, a checkout that could not be opened is an operational fact the
 * caller has to be able to report and retry.
 */
export async function openProviderCheckout(provider: string, request: ProviderCheckoutRequest): Promise<CheckoutHandoff | null> {
  const adapter = adapters.get(provider);
  if (adapter?.openCheckout === undefined) {
    return null;
  }
  return adapter.openCheckout(request);
}

/** Whether this process could hand a customer to the provider at all, as opposed to only receiving its events. */
export function billingProviderCanCheckout(provider: string): boolean {
  return adapters.get(provider)?.openCheckout !== undefined;
}

/**
 * Opens a provider-hosted management session for a route, or refuses.
 *
 * `null` for an unknown provider and for an adapter that has no such page — the same answer, because to
 * the screen they are the same fact: there is no link to offer. A provider error propagates, as it does
 * for a checkout: a page that could not be opened is an operational fact the caller reports.
 */
export async function openProviderManagementSession(provider: string, request: ProviderManagementRequest): Promise<CheckoutHandoff | null> {
  const adapter = adapters.get(provider);
  if (adapter?.openManagementSession === undefined) {
    return null;
  }
  return adapter.openManagementSession(request);
}

/** Whether this process could offer a provider-hosted management page for the provider at all. */
export function billingProviderCanManage(provider: string): boolean {
  return adapters.get(provider)?.openManagementSession !== undefined;
}

/**
 * Asks the provider to stop or restart renewing an arrangement, and reports what it then says.
 *
 * `null` for an adapter with no renewal to change. Nothing here records anything: stopping a renewal does
 * not end an entitlement, and the only thing that may is a verified event when the period actually ends.
 */
export async function setProviderRenewal(provider: string, request: ProviderRenewalRequest): Promise<ProviderRenewalState | null> {
  const adapter = adapters.get(provider);
  if (adapter?.setRenewal === undefined) {
    return null;
  }
  return adapter.setRenewal(request);
}

/** Whether this process could stop or restart a renewal with the provider at all. */
export function billingProviderCanSetRenewal(provider: string): boolean {
  return adapters.get(provider)?.setRenewal !== undefined;
}

/**
 * Asks the provider what it says is true, and mints the result.
 *
 * The repair path ADR-019 allows alongside verified webhooks: a delivery that never arrived, or arrived
 * and was lost, leaves the product's state behind the provider's, and the fix is to read the provider
 * rather than to believe a customer's browser. Refused for an adapter that has no authoritative read.
 */
export async function reconcileProviderState(provider: string, query: ReconciliationQuery): Promise<VerifiedBillingEvent | null> {
  const adapter = adapters.get(provider);
  if (adapter?.reconcile === undefined) {
    return null;
  }
  const normalized = await adapter.reconcile(query);
  return normalized === null ? null : mint(normalized, "RECONCILIATION");
}

function mint(normalized: NormalizedBillingEvent, activationSource: ActivationSource): VerifiedBillingEvent | null {
  if (!isBillingEventKind(normalized.kind)) {
    return null;
  }
  if (normalized.routeCode.trim() === "" || normalized.providerEventId.trim() === "") {
    return null;
  }
  if (normalized.settled !== undefined && (!Number.isInteger(normalized.settled.amountMinor) || !isCurrencyCode(normalized.settled.currency))) {
    return null;
  }
  // A copy, frozen, with its own dates and money: a caller holding a minted event cannot edit the amount
  // or the period in it and hand it on, and the adapter cannot reach into one it already handed over.
  const event = snapshot({ ...normalized, activationSource });
  mintedEvents.set(event, fingerprint(event));
  return event;
}

/**
 * Whether this module minted the event, and whether it is still the event that was minted.
 *
 * A predicate rather than an assertion, so the refusal can be phrased by whoever is refusing — the store
 * answers a forged event with its own input error, and nothing is gained by this file owning that
 * sentence. The asymmetry that matters is unchanged: anybody may ask "is this verified?", and nobody
 * outside this file may make the answer yes, because the map is not reachable and the recorded facts are
 * recomputed rather than trusted.
 */
export function isMintedBillingEvent(event: VerifiedBillingEvent): boolean {
  if (typeof event !== "object" || event === null) {
    return false;
  }
  const authenticated = mintedEvents.get(event);
  return authenticated !== undefined && authenticated === fingerprint(event);
}

/**
 * The authenticated copy a caller cannot reach, or `null` if this module did not mint the event.
 *
 * Asserting alone was not enough, and PR #100's review showed why: `isMintedBillingEvent` answers a
 * question about one instant, and a store that checks and then awaits a query is holding an object its
 * caller still has a reference to — a renewal minted for January was moved to 2099 while a route lookup
 * was pending, and bought service until 2099. Re-checking after every await would not fix it either,
 * because there is always another await. So the facts are copied out once, here, and everything
 * downstream reads the copy. The copy is itself minted, so it stays verified for anything that asks again.
 *
 * `null` rather than a throw, for the same reason the predicate is a predicate: the layer that refuses
 * owns the sentence it refuses with.
 */
export function snapshotMintedBillingEvent(event: VerifiedBillingEvent): VerifiedBillingEvent | null {
  if (!isMintedBillingEvent(event)) {
    return null;
  }
  const copy = snapshot(event);
  mintedEvents.set(copy, fingerprint(copy));
  return copy;
}
