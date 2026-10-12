/**
 * @omnichannel/billing-stripe
 *
 * The Stripe adapter for the application-owned billing provider port (Issue #41, ADR-017, ADR-020).
 * Speaks to Stripe over HTTP with no vendor SDK; holds no database access and no product state.
 */
export { createStripeBillingAdapter, STRIPE_PROVIDER, type StripeAdapterConfig, type StripeRouteConfig } from "./adapter";
export { STRIPE_API_VERSION, StripeCallFailed, type StripeFailureKind } from "./api";
export { CONTRACT_METADATA_KEY } from "./events";
export {
  SIGNATURE_TOLERANCE_MINUTES,
  STRIPE_SIGNATURE_HEADER,
  verifyStripeSignature,
  type SignatureCheck,
  type SignatureRejection,
  type SignatureVerdict,
} from "./signature";
export {
  createFetchBillingHttpPort,
  formEncode,
  type BillingHttpPort,
  type BillingHttpRequest,
  type BillingHttpResult,
  type BillingHttpMethod,
} from "./transport";
