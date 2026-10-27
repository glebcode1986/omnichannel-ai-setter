/**
 * Handing a customer to the provider that will take their money (Issue #41, ADR-019, ADR-020).
 *
 * This runs *after* the checkout contract and its acceptance snapshot are committed, and that order is
 * the point. The contract is the record of what was agreed and by whom; the provider session is a page
 * somebody is sent to. A session opened first and a contract written second would leave a paid session
 * with nothing to attribute it to, and the settlement would arrive as `UNATTRIBUTED`.
 *
 * **Nothing here is taken from the request.** The route, the seller, the arrangement kind, the amount and
 * the provider's price are all read back from the committed contract by its id. A client that could name
 * a price could name a cheaper one; a client that could name a route could point a Ukrainian FOP's
 * checkout at a Romanian company's Stripe account, which is exactly what ADR-019 forbids.
 *
 * **A missing piece means no hand-off, not a broken one.** No adapter registered, no return URL
 * configured, no provider price published: each of those leaves the contract standing and the billing page
 * saying the payment step is next. The alternative — a redirect built from a default — is a customer sent
 * to a page that charges a number nobody published.
 *
 * **The redirect never grants anything.** It is a page, and the only thing that activates an entitlement
 * is a verified provider event or an authoritative reconciliation.
 */
import {
  attachProviderCheckoutReference,
  billingProviderCanCheckout,
  openProviderCheckout,
  readCheckoutRouting,
  type CheckoutHandoff,
  type DbClient,
} from "@omnichannel/db";
import type { Logger } from "@omnichannel/observability";

export interface ProviderCheckoutRequestInput {
  readonly db: DbClient;
  readonly logger: Logger;
  readonly checkoutContractId: string;
  /** The absolute HTTPS origin a provider sends the customer back to. Configured, never derived. */
  readonly returnBaseUrl: string | undefined;
  /** Where the customer lands either way; the outcome in the query says which happened. */
  readonly returnPath: string;
  readonly ensureAdapters: () => void;
}

/**
 * The hand-off, or `undefined` when this deployment cannot offer one.
 *
 * Why the two are one answer: to the person at the keyboard, "no provider configured", "no price
 * published" and "this route has no checkout" are the same fact — there is no payment page to go to. The
 * log line says which, because that distinction is an operator's.
 */
export async function requestProviderCheckout(input: ProviderCheckoutRequestInput): Promise<CheckoutHandoff | undefined> {
  if (input.returnBaseUrl === undefined) {
    input.logger.warn("billing.checkout_handoff_unconfigured", { reason: "BILLING_RETURN_BASE_URL is not configured" });
    return undefined;
  }
  input.ensureAdapters();

  const routing = await readCheckoutRouting(input.db, input.checkoutContractId);
  if (routing === null) {
    return undefined;
  }
  if (!billingProviderCanCheckout(routing.provider)) {
    // The provider may still receive events on this route without this process being the one that opens
    // its sessions, which is why "registered" and "can open a checkout" are different questions.
    input.logger.warn("billing.checkout_handoff_unavailable", { routeCode: routing.routeCode, reason: "no adapter can open a checkout" });
    return undefined;
  }
  if (routing.providerPriceRef === null) {
    input.logger.warn("billing.checkout_handoff_unpriced", { routeCode: routing.routeCode, reason: "the catalogue has no provider price for this plan version" });
    return undefined;
  }

  const handoff = await openProviderCheckout(routing.provider, {
    routeCode: routing.routeCode,
    arrangement: routing.arrangementKind,
    amountMinor: routing.charge.amountMinor,
    currency: routing.charge.currency,
    priceReference: routing.providerPriceRef,
    // The contract id, which is what comes back on the settlement and the only thing tying it to a
    // customer. Opaque and workspace-scoped: it names nothing about the person.
    clientReference: input.checkoutContractId,
    // `checkout`, not `outcome`, and these two words: this is the parameter the billing page reads
    // (`billing-screen.ts`), and it accepts exactly "success" and "cancelled". These URLs used to say
    // `?outcome=CHECKOUT_RETURNED`, which no reader in the product matches — a customer who paid, and a
    // customer who backed out, both came back to a page that said nothing had happened.
    successUrl: absolute(input.returnBaseUrl, `${input.returnPath}?checkout=success`),
    cancelUrl: absolute(input.returnBaseUrl, `${input.returnPath}?checkout=cancelled`),
  });
  if (handoff === null) {
    return undefined;
  }
  if (handoff.reference !== undefined) {
    // Write-once, in this function and again in a trigger. A second reference would mean a second
    // session, and a settlement granted against one of them could not be matched to the other.
    await attachProviderCheckoutReference(input.db, input.checkoutContractId, handoff.reference);
  }
  input.logger.info("billing.checkout_handoff_opened", { routeCode: routing.routeCode, handoff: handoff.kind });
  return handoff;
}

/**
 * A return URL built from the configured origin and a path this app owns.
 *
 * `new URL(path, origin)` rather than string concatenation, so a path that happens to start with `//` or
 * to carry a scheme cannot replace the origin — the one way a return URL becomes somebody else's page.
 */
function absolute(origin: string, path: string): string {
  return new URL(path.startsWith("/") ? path.slice(1) : path, origin.endsWith("/") ? origin : `${origin}/`).toString();
}
