/**
 * The billing composition root (Issue #41).
 *
 * Two cases, and they are the ones that decide whether this feature exists in production at all. Without
 * a registration every port function answers "no such provider", which is the shape of defect this file
 * was written to close — and with a *partial* one, a process would accept deliveries it cannot
 * authenticate. So: configured registers, unconfigured registers nothing, and neither says a secret out
 * loud.
 */
import { billingProviderCanCheckout, billingProviderRegistered, clearBillingProviders } from "@omnichannel/db";
import { STRIPE_PROVIDER } from "@omnichannel/billing-stripe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerBillingAdapters } from "./billing-adapters";

const ROUTES = [
  { routeCode: "stripe-ua-fop", secretKey: "rk_test_ua", webhookSecrets: ["whsec_ua"] },
  { routeCode: "stripe-ro-company", secretKey: "rk_test_ro", webhookSecrets: ["whsec_ro"] },
];

const logged: { level: string; event: string; fields: Readonly<Record<string, unknown>> }[] = [];
const logger = () => {
  const record = (level: string) => (event: string, fields: Readonly<Record<string, unknown>> = {}) => {
    logged.push({ level, event, fields });
  };
  return { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") } as never;
};

beforeEach(() => {
  clearBillingProviders();
  logged.length = 0;
});

afterEach(() => {
  clearBillingProviders();
});

describe("registering the billing adapters this deployment has", () => {
  it("registers one adapter for every configured route, and says which routes", () => {
    const codes = registerBillingAdapters({ env: { STRIPE_ROUTES: ROUTES }, logger: logger() });

    expect(codes).toEqual(["stripe-ua-fop", "stripe-ro-company"]);
    expect(billingProviderRegistered(STRIPE_PROVIDER)).toBe(true);
    // Registered *and* able to open a checkout are different questions; a route may exist only to
    // receive events.
    expect(billingProviderCanCheckout(STRIPE_PROVIDER)).toBe(true);
    expect(logged).toEqual([
      { level: "info", event: "billing.adapter_registered", fields: { provider: STRIPE_PROVIDER, routeCodes: "stripe-ua-fop,stripe-ro-company" } },
    ]);
    // Route codes are the product's own identifiers. A key, a signing secret and a Stripe account are
    // not, and none of them belongs in a log line.
    const everything = JSON.stringify(logged);
    expect(everything).not.toContain("rk_test");
    expect(everything).not.toContain("whsec_");
  });

  it("registers nothing at all when no route is configured", () => {
    const codes = registerBillingAdapters({ env: {}, logger: logger() });

    // A half-configured process that accepted a delivery it cannot authenticate would be worse than one
    // that refuses every delivery, and this is the second.
    expect(codes).toEqual([]);
    expect(billingProviderRegistered(STRIPE_PROVIDER)).toBe(false);
    expect(logged).toEqual([
      { level: "warn", event: "billing.adapter_unconfigured", fields: { provider: STRIPE_PROVIDER, reason: "STRIPE_ROUTES is not configured" } },
    ]);
  });

  it("treats an empty list the same as no list", () => {
    expect(registerBillingAdapters({ env: { STRIPE_ROUTES: [] }, logger: logger() })).toEqual([]);
    expect(billingProviderRegistered(STRIPE_PROVIDER)).toBe(false);
  });
});
