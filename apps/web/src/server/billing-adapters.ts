/**
 * The billing provider adapters this deployment can use (Issue #41, ADR-017, ADR-020).
 *
 * The composition root, and the reason it exists at all: `verifyProviderDelivery`, `openProviderCheckout`
 * and `reconcileProviderState` resolve an adapter from a process-local registry, so without a caller to
 * `registerBillingProvider` every one of them answers "no such provider" — the whole commercial half of
 * the product would be unreachable in production while each of its parts passed its own tests. That is the
 * same defect `channel-adapters.ts` was written to close for the inbound half.
 *
 * **Missing configuration registers nothing.** A deployment with no `STRIPE_ROUTES` has no Stripe adapter,
 * so a billing webhook is refused before verification and the billing screen reports that checkout is not
 * available — rather than a half-configured process accepting a delivery it cannot authenticate.
 *
 * **Registration is idempotent and happens on first use**, not at import time: a module that reached for
 * the environment while Next.js was building would make a build depend on a production secret.
 */
import { billingProviderRegistered, registerBillingProvider } from "@omnichannel/db";
import { createStripeBillingAdapter, STRIPE_PROVIDER } from "@omnichannel/billing-stripe";
import type { Logger } from "@omnichannel/observability";

import type { WebEnv } from "../env";
import { loadWebEnv } from "../env";
import { getLogger } from "./logger";

export interface BillingAdapterOptions {
  readonly env: Pick<WebEnv, "STRIPE_ROUTES">;
  readonly logger: Logger;
}

/**
 * Registers every configured provider adapter, and says which once.
 *
 * The log line names route codes — the product's own identifiers — and never a key, a signing secret or a
 * Stripe account. An operator needs to know which routes this process can serve; nothing else about them
 * belongs in a log.
 */
export function registerBillingAdapters(options: BillingAdapterOptions): readonly string[] {
  const routes = options.env.STRIPE_ROUTES;
  if (routes === undefined || routes.length === 0) {
    options.logger.warn("billing.adapter_unconfigured", { provider: STRIPE_PROVIDER, reason: "STRIPE_ROUTES is not configured" });
    return [];
  }
  registerBillingProvider(createStripeBillingAdapter({ routes }));
  const codes = routes.map((route) => route.routeCode);
  options.logger.info("billing.adapter_registered", { provider: STRIPE_PROVIDER, routeCodes: codes.join(",") });
  return codes;
}

let registered = false;

/** Production composition, built on first use. Safe to call from every request. */
export function ensureBillingAdapters(): void {
  if (registered) {
    return;
  }
  registered = true;
  registerBillingAdapters({ env: loadWebEnv(), logger: getLogger() });
}

/** Whether this process could act as the named provider at all. For a screen deciding what to offer. */
export function billingProviderAvailable(provider: string = STRIPE_PROVIDER): boolean {
  ensureBillingAdapters();
  return billingProviderRegistered(provider);
}
