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
 */
import { isMintedBillingEvent, type VerifiedBillingEvent } from "@omnichannel/application";

import { DbInputError } from "./errors";

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
 * event is verified, and nobody outside `provider-port.ts` may make the answer yes, because the WeakSet
 * is unreachable and the minted objects are frozen. A structural cast produces an object that type-checks
 * and fails here.
 */
export function assertVerifiedBillingEvent(event: VerifiedBillingEvent): void {
  if (!isMintedBillingEvent(event)) {
    throw new DbInputError(
      "event",
      "only a verified provider delivery or an authoritative reconciliation activates billing; a redirect does not",
    );
  }
}
