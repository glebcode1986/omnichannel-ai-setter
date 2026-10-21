/**
 * What `pnpm billing:publish-routes` accepts, and what it says about what it refuses.
 *
 * The validation is the part worth testing without a database, and the cases that matter are the refusals:
 * a deployment whose routing document is subtly wrong does not fail at startup, it fails at the first
 * customer's checkout with `NO_ROUTE` — so the command has to be the thing that notices.
 *
 * Two properties are deliberate and are asserted here rather than left to the reader. Every fault is
 * reported, not just the first, because a list is one round of editing. And no value is ever echoed: the
 * document carries provider account references, and ADR-017 keeps those out of what a person reads.
 */
import { describe, expect, it } from "vitest";

import { readBillingRoutingConfig, type ConfigFault } from "./publish-routes.ts";

const seller = {
  code: "ua-fop",
  legalName: "Example FOP",
  displayName: "Example",
  jurisdiction: "UA",
  supportEmail: "billing@example.test",
};

const route = {
  code: "direct-eu",
  provider: "stripe",
  sellerProfileCode: "ua-fop",
  settlementModel: "DIRECT_PSP",
  capabilities: ["RECURRING_SUBSCRIPTIONS", "VERIFIED_WEBHOOKS"],
  currencies: ["EUR"],
  intervals: ["MONTH", "YEAR"],
  enabled: true,
};

const faultsOf = (raw: unknown): readonly ConfigFault[] => {
  const read = readBillingRoutingConfig(raw);
  if (!("faults" in read)) {
    throw new Error("expected the document to be refused");
  }
  return read.faults;
};

const paths = (raw: unknown) => faultsOf(raw).map((fault) => fault.path);

describe("reading a deployment's routing configuration", () => {
  it("accepts a seller and a route that names it", () => {
    const read = readBillingRoutingConfig({ sellers: [seller], routes: [route] });

    expect("config" in read).toBe(true);
    if ("config" in read) {
      expect(read.config.routes.map((entry) => entry.code)).toEqual(["direct-eu"]);
    }
  });

  it("refuses a route naming a seller the document does not define", () => {
    // The whole reason sellers and routes share one variable. Split across two, this mistake is found by
    // the first customer who tries to pay.
    expect(paths({ sellers: [seller], routes: [{ ...route, sellerProfileCode: "ro-srl" }] })).toEqual([
      "routes[0].sellerProfileCode",
    ]);
  });

  it("reports every fault rather than the first", () => {
    const found = paths({
      sellers: [{ ...seller, legalName: "", supportEmail: 7 }],
      routes: [{ ...route, code: "", capabilities: [], intervals: "MONTH" }],
    });

    expect(found).toEqual([
      "sellers[0].legalName",
      "sellers[0].supportEmail",
      "routes[0].code",
      "routes[0].capabilities",
      "routes[0].intervals",
    ]);
  });

  it("never echoes a value, only the path and the problem", () => {
    const secretish = "acct_1ExampleProviderAccountRef";
    const found = faultsOf({ sellers: [seller], routes: [{ ...route, code: 42, providerAccountRef: secretish, currencies: [] }] });

    expect(JSON.stringify(found)).not.toContain(secretish);
    expect(JSON.stringify(found)).not.toContain("42");
  });

  it("refuses a document that is not an object, or whose halves are not arrays", () => {
    expect(paths("stripe")).toEqual(["BILLING_ROUTING"]);
    expect(paths([])).toEqual(["BILLING_ROUTING"]);
    expect(paths({ sellers: {}, routes: {} })).toEqual(["sellers", "routes"]);
  });

  it("accepts an empty document, because a deployment that takes no money is a supported one", () => {
    // The command refuses an absent variable; an explicitly empty one is a deployment saying it sells
    // nothing yet, and that is not a configuration error.
    const read = readBillingRoutingConfig({ sellers: [], routes: [] });
    expect("config" in read).toBe(true);
  });

  it("leaves coherence to the store that owns the rule", () => {
    // An impossible capability set and a nonsense currency are both accepted here and refused by
    // `upsertBillingRoute`, against the same CHECK the table enforces. Validating them twice would be two
    // places holding one rule, and the store's message names which of the thirteen capabilities is wrong.
    const read = readBillingRoutingConfig({
      sellers: [seller],
      routes: [{ ...route, capabilities: ["NOT_A_CAPABILITY"], currencies: ["ZZZ"] }],
    });
    expect("config" in read).toBe(true);
  });

  it("checks the optional fields only when they are there", () => {
    expect("config" in readBillingRoutingConfig({ sellers: [seller], routes: [{ ...route, priority: 3, markets: ["UA"] }] })).toBe(true);
    expect(paths({ sellers: [seller], routes: [{ ...route, priority: 1.5 }] })).toEqual(["routes[0].priority"]);
    expect(paths({ sellers: [seller], routes: [{ ...route, enabled: "yes" }] })).toEqual(["routes[0].enabled"]);
    expect(paths({ sellers: [{ ...seller, legalConfigRef: "" }], routes: [route] })).toEqual(["sellers[0].legalConfigRef"]);
  });
});
