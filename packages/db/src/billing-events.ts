/**
 * The billing provider port, as the persistence layer sees it.
 *
 * The port itself lives in `@omnichannel/application` — ADR-017 puts provider-neutral ports there, and an
 * adapter package has to be able to name the interface it implements without importing this one. What
 * stays here is the single sentence this layer owns: a forged verified event is refused with this
 * package's own input error, in this package's own words, because `recordVerifiedBillingEvent` is the
 * caller that has to say no.
 *
 * Everything else is re-exported unchanged, so that every existing caller of `@omnichannel/db` keeps
 * working and there is one place to look for the port's surface from either side.
 *
 * Two sentences this layer owns, and both are refusals. `assertVerifiedBillingEvent` answers a forged or
 * altered event, and `snapshotVerifiedBillingEvent` answers the same thing while taking the copy a store
 * can hold across an await. The port decides *whether* an event is still the one it minted — it
 * recomputes the authenticated facts rather than testing membership, because `Object.freeze` is shallow
 * and a `Date` inside a frozen event is still mutable. What is decided here is only how to say no.
 */
import { isMintedBillingEvent, snapshotMintedBillingEvent, type VerifiedBillingEvent } from "@omnichannel/application";

import { DbInputError } from "./errors";

/** One sentence for both refusals: a forged event and an edited one fail for the same reason. */
const REFUSAL =
  "only a verified provider delivery or an authoritative reconciliation activates billing, unaltered since it was verified; a redirect does not";

export {
  billingProviderCanCheckout,
  billingProviderCanManage,
  billingProviderCanSetRenewal,
  billingProviderRegistered,
  clearBillingProviders,
  isMintedBillingEvent,
  openProviderCheckout,
  openProviderManagementSession,
  reconcileProviderState,
  setProviderRenewal,
  registerBillingProvider,
  verifyProviderDelivery,
  type BillingProviderAdapter,
  type CheckoutHandoff,
  type NormalizedBillingEvent,
  type ProviderAcknowledgement,
  type ProviderCheckoutRequest,
  type ProviderManagementRequest,
  type ProviderRenewalRequest,
  type ProviderRenewalState,
  type RawProviderDelivery,
  type ReconciliationQuery,
  type VerifiedBillingEvent,
  type VerifiedDelivery,
  type VerifiedProviderDelivery,
} from "@omnichannel/application";

/**
 * Refuses an event the port did not mint.
 *
 * The asymmetry is the whole design, and moving the mint did not change it: anybody may ask whether an
 * event is verified, and nobody outside `provider-port.ts` may make the answer yes, because the map of
 * authenticated facts is unreachable. A structural cast produces an object that type-checks and fails
 * here, and so does a minted event somebody edited afterwards.
 */
export function assertVerifiedBillingEvent(event: VerifiedBillingEvent): void {
  if (!isMintedBillingEvent(event)) {
    throw new DbInputError("event", REFUSAL);
  }
}

/**
 * Authenticates a delivered event and returns the copy the caller cannot reach.
 *
 * This is what a trust boundary needs, and asserting alone was not it. `assertVerifiedBillingEvent`
 * answers a question about one instant; a store that asserts and then awaits a query is holding an object
 * its caller still has a reference to, and a `Date` inside it can be moved while that query is pending.
 * PR #100's review demonstrated exactly that: a renewal minted for January, mutated to 2099 during a
 * pending route lookup, granted service until 2099.
 *
 * Re-checking the same object after each await would not fix it either — there is always another await.
 * So the authenticated facts are copied out once, here, and everything downstream reads the copy. The
 * returned event is itself minted, so it stays a `VerifiedBillingEvent` for anything that asserts again.
 */
export function snapshotVerifiedBillingEvent(event: VerifiedBillingEvent): VerifiedBillingEvent {
  const copy = snapshotMintedBillingEvent(event);
  if (copy === null) {
    throw new DbInputError("event", REFUSAL);
  }
  return copy;
}
