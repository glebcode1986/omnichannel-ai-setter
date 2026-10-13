/**
 * The only two ways a payment becomes a fact (#46, ADR-019).
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
 * frozen objects this module mints — tracked in a module-private `WeakSet`, exactly as `tenancy.ts`
 * tracks the contexts it issued. Minting happens in two functions and both go through a registered
 * provider adapter: `verifyProviderDelivery`, which hands the adapter a raw signed delivery to
 * authenticate, and `reconcileProviderState`, which asks the adapter what the provider itself says is
 * true. A caller with a plan identifier and good intentions has no way to produce one, and a structural
 * type assertion does not help them: the WeakSet is not reachable and the objects are frozen.
 *
 * Nothing here parses a provider's payload, and nothing here holds a secret. The adapter owns signature
 * verification and raw parsing, and what crosses this line is normalized and provider-neutral — which is
 * also why no raw payload, signature or header reaches the `billing_events` row.
 */
import type { BillingEventKind, Money } from "@omnichannel/domain";
import { isBillingEventKind, isCurrencyCode, type ActivationSource } from "@omnichannel/domain";

import { DbInputError } from "./errors";

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
 * casting to the type does not produce one — `recordVerifiedBillingEvent` checks membership of a WeakSet
 * this module never exposes.
 */
export type VerifiedBillingEvent = NormalizedBillingEvent & {
  readonly activationSource: ActivationSource;
};

const mintedEvents = new WeakSet<object>();

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
 * One billing provider's adapter.
 *
 * `verify` returns `null` for anything it cannot authenticate, and that includes a payload it could parse
 * perfectly: an unsigned or wrongly-signed delivery is indistinguishable from an attacker's, and both get
 * the same answer. `reconcile` is optional because not every provider offers an authoritative read; a
 * route whose adapter has none must declare `AUTHORITATIVE_RECONCILIATION` off, and the CHECK on
 * `billing_routes` then refuses to enable it unless it has verified webhooks instead.
 */
export interface BillingProviderAdapter {
  readonly provider: string;
  readonly verify: (delivery: RawProviderDelivery) => NormalizedBillingEvent | null;
  readonly reconcile?: (query: ReconciliationQuery) => Promise<NormalizedBillingEvent | null>;
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
    throw new DbInputError("provider", "an adapter has a name");
  }
  adapters.set(adapter.provider, adapter);
}

/** Forgets every registration. For tests, so one suite's stub cannot answer another's delivery. */
export function clearBillingProviders(): void {
  adapters.clear();
}

/**
 * Authenticates a raw delivery and mints the verified event, or refuses.
 *
 * `null` for an unknown provider, for a delivery the adapter would not authenticate, and for a normalized
 * event that is not usable — the last case checked here rather than trusted, because an adapter is
 * third-party-shaped code and a `kind` outside the product's vocabulary would otherwise reach a column
 * and fail there, with the provider's name on a database error instead of a refusal.
 */
export function verifyProviderDelivery(delivery: RawProviderDelivery): VerifiedBillingEvent | null {
  const adapter = adapters.get(delivery.provider);
  if (adapter === undefined) {
    return null;
  }
  const normalized = adapter.verify(delivery);
  return normalized === null ? null : mint(normalized, "VERIFIED_EVENT");
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
  // Frozen, so that a caller holding a minted event cannot edit the amount in it and hand it on; the
  // WeakSet would still recognize the object.
  const event = Object.freeze({ ...normalized, activationSource }) as VerifiedBillingEvent;
  mintedEvents.add(event);
  return event;
}

/**
 * Refuses an event this module did not mint.
 *
 * Exported so the store can call it; the WeakSet it consults is not. That asymmetry is the whole design:
 * anybody may ask "is this verified?", nobody outside this file may make the answer yes.
 */
export function assertVerifiedBillingEvent(event: VerifiedBillingEvent): void {
  if (typeof event !== "object" || event === null || !mintedEvents.has(event)) {
    throw new DbInputError(
      "event",
      "only a verified provider delivery or an authoritative reconciliation activates billing; a redirect does not",
    );
  }
}
