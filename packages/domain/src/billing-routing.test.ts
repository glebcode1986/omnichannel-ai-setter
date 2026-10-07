/**
 * Routing decisions, money and the activation rule (#46, ADR-019).
 *
 * Three of these tests are about something not happening: a redirect not activating, a late settlement not
 * activating, an underpayment not activating. They are the point of the file — every other failure mode
 * here costs money once, and this class of failure gives the product away.
 */
import { describe, expect, it } from "vitest";

import { DomainValidationError } from "./errors";
import {
  acceptedInOwnLanguage,
  ARRANGEMENT_KINDS,
  arrangementsOf,
  activationSourcesOf,
  BILLING_CAPABILITIES,
  BILLING_EVENT_KINDS,
  entitlementEffectOf,
  isCurrencyCode,
  LEGAL_DOCUMENT_KINDS,
  missingAcceptances,
  money,
  negotiateDocumentLocale,
  periodEndFor,
  quoteVerdict,
  routeAdmits,
  routeSupports,
  sameMoney,
  selectRoute,
  settlementModelCoherent,
  taxRemittedBy,
  type BillingCapability,
  type BillingRouteTerms,
  type PaymentQuote,
} from "./index";

/** A card processor that leaves us the seller: the plainest route there is. */
function directPsp(overrides: Partial<BillingRouteTerms> = {}): BillingRouteTerms {
  return {
    routeId: "route-direct",
    code: "direct-eu",
    settlementModel: "DIRECT_PSP",
    capabilities: ["RECURRING_SUBSCRIPTIONS", "REFUNDS", "DISPUTES", "TAX_CALCULATION", "INVOICES", "CUSTOMER_PORTAL", "VERIFIED_WEBHOOKS", "PRORATION"],
    currencies: ["EUR"],
    intervals: ["MONTH", "YEAR"],
    markets: [],
    enabled: true,
    priority: 10,
    ...overrides,
  };
}

/** A Merchant of Record: it is the seller to the customer and it remits the tax. */
function merchantOfRecord(overrides: Partial<BillingRouteTerms> = {}): BillingRouteTerms {
  return {
    routeId: "route-mor",
    code: "mor-global",
    settlementModel: "MERCHANT_OF_RECORD",
    capabilities: [
      "RECURRING_SUBSCRIPTIONS",
      "REFUNDS",
      "DISPUTES",
      "TAX_CALCULATION",
      "TAX_REMITTANCE",
      "INVOICES",
      "CUSTOMER_PORTAL",
      "VERIFIED_WEBHOOKS",
      "MULTI_CURRENCY",
    ],
    currencies: ["EUR", "USD"],
    intervals: ["MONTH", "YEAR"],
    markets: [],
    enabled: true,
    priority: 20,
    ...overrides,
  };
}

/** A crypto processor: no subscriptions, a prepaid term, and a quote with a clock on it. */
function cryptoProcessor(overrides: Partial<BillingRouteTerms> = {}): BillingRouteTerms {
  return {
    routeId: "route-crypto",
    code: "crypto-usdt",
    settlementModel: "CRYPTO_PROCESSOR",
    capabilities: ["PREPAID_TERM", "TIMED_QUOTES", "VERIFIED_WEBHOOKS", "AUTHORITATIVE_RECONCILIATION", "MULTI_CURRENCY"],
    currencies: ["USDT", "BTC"],
    intervals: ["MONTH", "YEAR"],
    markets: [],
    enabled: true,
    priority: 30,
    ...overrides,
  };
}

describe("a route's capabilities", () => {
  it("keeps tax calculation and tax remittance apart", () => {
    // The distinction the whole settlement model rests on: a processor that works out VAT for us has not
    // thereby become the seller who owes it.
    const calculatesOnly = directPsp();

    expect(routeSupports(calculatesOnly, "TAX_CALCULATION")).toBe(true);
    expect(routeSupports(calculatesOnly, "TAX_REMITTANCE")).toBe(false);
    expect(taxRemittedBy(calculatesOnly)).toBe("SELLER");
    expect(taxRemittedBy(merchantOfRecord())).toBe("PROVIDER");
  });

  it("decides which arrangements a route can drive from what it declares, not from its class", () => {
    expect(arrangementsOf(directPsp())).toEqual(["RECURRING"]);
    expect(arrangementsOf(cryptoProcessor())).toEqual(["PREPAID_TERM"]);
    expect(arrangementsOf(merchantOfRecord({ capabilities: [...merchantOfRecord().capabilities, "PREPAID_TERM"] }))).toEqual([...ARRANGEMENT_KINDS]);
  });

  it("names every way a route is incoherent, not the first one", () => {
    const broken: BillingRouteTerms = {
      routeId: "r",
      code: "broken",
      settlementModel: "MERCHANT_OF_RECORD",
      capabilities: [],
      currencies: [],
      intervals: [],
      markets: [],
      enabled: true,
      priority: 0,
    };

    expect(settlementModelCoherent(broken)).toEqual(["MOR_WITHOUT_TAX_REMITTANCE", "NO_ARRANGEMENT", "NO_ACTIVATION_SOURCE", "EMPTY_TERMS"]);
  });

  it("refuses a crypto route with no quote capability and a second currency nobody declared", () => {
    expect(settlementModelCoherent(cryptoProcessor({ capabilities: ["PREPAID_TERM", "VERIFIED_WEBHOOKS"] }))).toEqual([
      "CRYPTO_WITHOUT_QUOTES",
      "MULTI_CURRENCY_UNDECLARED",
    ]);
  });

  it("accepts every coherent route in this file, so the fixtures are not quietly broken", () => {
    for (const route of [directPsp(), merchantOfRecord(), cryptoProcessor()]) {
      expect(settlementModelCoherent(route), route.code).toEqual([]);
    }
  });

  it("knows the two ways a payment can become a fact, and that a route may have neither", () => {
    expect(activationSourcesOf(directPsp())).toEqual(["VERIFIED_EVENT"]);
    expect(activationSourcesOf(cryptoProcessor())).toEqual(["VERIFIED_EVENT", "RECONCILIATION"]);
    expect(activationSourcesOf(directPsp({ capabilities: ["RECURRING_SUBSCRIPTIONS"] }))).toEqual([]);
  });

  it("covers every declared capability in the fixtures above, so none is untested by accident", () => {
    const declared = new Set<BillingCapability>([...directPsp().capabilities, ...merchantOfRecord().capabilities, ...cryptoProcessor().capabilities]);

    expect([...BILLING_CAPABILITIES].filter((capability) => !declared.has(capability))).toEqual([]);
  });
});

describe("selecting a route for a checkout", () => {
  const monthlyEur = { arrangement: "RECURRING", interval: "MONTH", currency: "EUR" } as const;

  it("takes the lowest priority among the routes that admit the request", () => {
    const selection = selectRoute([merchantOfRecord(), directPsp()], monthlyEur);

    expect(selection).toMatchObject({ selected: true, route: { code: "direct-eu" } });
  });

  it("breaks a tie by code, so the same request never lands on a different seller entity", () => {
    const first = merchantOfRecord({ code: "aaa", priority: 5 });
    const second = merchantOfRecord({ code: "bbb", priority: 5 });

    expect(selectRoute([second, first], monthlyEur)).toMatchObject({ selected: true, route: { code: "aaa" } });
    expect(selectRoute([first, second], monthlyEur)).toMatchObject({ selected: true, route: { code: "aaa" } });
  });

  it("explains every refusal rather than reporting that nothing was available", () => {
    const selection = selectRoute([directPsp({ enabled: false }), cryptoProcessor(), merchantOfRecord({ currencies: ["USD"] })], monthlyEur);

    expect(selection).toEqual({
      selected: false,
      refusals: [
        { code: "direct-eu", refusal: "ROUTE_DISABLED" },
        { code: "crypto-usdt", refusal: "ARRANGEMENT_UNSUPPORTED" },
        { code: "mor-global", refusal: "CURRENCY_UNSUPPORTED" },
      ],
    });
  });

  it("will not select an incoherent route even when every product fact matches", () => {
    // Configuration faults are refused at selection as well as at write time. A route whose capabilities
    // contradict its settlement model would otherwise be chosen and then behave as neither.
    const incoherent = merchantOfRecord({ capabilities: ["RECURRING_SUBSCRIPTIONS", "VERIFIED_WEBHOOKS", "MULTI_CURRENCY"] });

    expect(routeAdmits(incoherent, monthlyEur)).toEqual({ admitted: false, refusal: "ROUTE_INCOHERENT" });
  });

  it("treats an empty market list as unrestricted and an unknown market as no restriction to apply", () => {
    const restricted = directPsp({ markets: ["DE", "FR"] });

    expect(routeAdmits(restricted, { ...monthlyEur, market: "DE" })).toEqual({ admitted: true });
    expect(routeAdmits(restricted, { ...monthlyEur, market: "BR" })).toEqual({ admitted: false, refusal: "MARKET_UNSUPPORTED" });
    // No market known: admitted. The market prefers a route, it does not prove a residence, and refusing
    // a checkout for want of a geolocation would be a gate on information the product does not have.
    expect(routeAdmits(restricted, monthlyEur)).toEqual({ admitted: true });
    expect(routeAdmits(directPsp(), { ...monthlyEur, market: "BR" })).toEqual({ admitted: true });
  });

  it("refuses an interval the route does not charge on", () => {
    expect(routeAdmits(directPsp({ intervals: ["YEAR"] }), monthlyEur)).toEqual({ admitted: false, refusal: "INTERVAL_UNSUPPORTED" });
  });

  it("has no parameter in which a client could name a route, an account or a seller", () => {
    // The structural answer to "never trust a client-supplied provider/account/entity identifier": the
    // request carries product facts only, so a forged identifier has nowhere to arrive. Spelled out as a
    // test because a later convenience parameter would break it silently.
    const forged = { ...monthlyEur, routeId: "route-mor", sellerProfileId: "attacker", provider: "attacker" };

    expect(selectRoute([directPsp(), merchantOfRecord()], forged)).toMatchObject({ selected: true, route: { code: "direct-eu" } });
  });
});

describe("money", () => {
  it("is a whole number of minor units of a named currency", () => {
    expect(money(1999, "EUR")).toEqual({ amountMinor: 1999, currency: "EUR" });
    expect(() => money(19.99, "EUR")).toThrow(DomainValidationError);
    expect(() => money(-1, "EUR")).toThrow(DomainValidationError);
    expect(() => money(1999, "eur")).toThrow(DomainValidationError);
    expect(() => money(1999, "E")).toThrow(DomainValidationError);
  });

  it("accepts payment-asset codes longer than three characters", () => {
    expect(isCurrencyCode("EUR")).toBe(true);
    expect(isCurrencyCode("USDT")).toBe(true);
    expect(isCurrencyCode("BTC")).toBe(true);
    expect(isCurrencyCode("1INCH")).toBe(false);
    expect(isCurrencyCode("")).toBe(false);
  });

  it("compares the currency as well as the number", () => {
    expect(sameMoney(money(1999, "EUR"), money(1999, "EUR"))).toBe(true);
    expect(sameMoney(money(1999, "EUR"), money(1999, "USD"))).toBe(false);
  });
});

describe("a time-bounded quote", () => {
  const quotedAt = new Date("2026-10-07T12:00:00.000Z");
  const expiresAt = new Date("2026-10-07T12:15:00.000Z");
  const at2026 = new Date("2026-10-07T12:05:00.000Z");
  const quote: PaymentQuote = { base: money(4900, "EUR"), charge: money(5_120_000, "USDT"), quotedAt, expiresAt };

  it("is pending while the window is open and nothing has arrived", () => {
    expect(quoteVerdict(quote, undefined, new Date("2026-10-07T12:05:00.000Z"))).toBe("PENDING");
  });

  it("expires when the window closes with nothing settled", () => {
    expect(quoteVerdict(quote, undefined, new Date("2026-10-07T12:16:00.000Z"))).toBe("EXPIRED");
  });

  it("settles on the full amount inside the window, however late it is read", () => {
    const settled = { amount: money(5_120_000, "USDT"), at: new Date("2026-10-07T12:14:59.000Z") };

    // Read an hour after the fact. Expiry is measured against the settlement, not against the reader.
    expect(quoteVerdict(quote, settled, new Date("2026-10-07T13:30:00.000Z"))).toBe("SETTLED");
  });

  it("settles on an overpayment, because refusing service to somebody who sent too much is absurd", () => {
    const settled = { amount: money(5_200_000, "USDT"), at: new Date("2026-10-07T12:10:00.000Z") };

    expect(quoteVerdict(quote, settled, new Date("2026-10-07T12:11:00.000Z"))).toBe("SETTLED");
  });

  it("calls a short payment underpaid rather than settled", () => {
    const settled = { amount: money(5_119_999, "USDT"), at: new Date("2026-10-07T12:10:00.000Z") };

    expect(quoteVerdict(quote, settled, new Date("2026-10-07T12:11:00.000Z"))).toBe("UNDERPAID");
  });

  it("calls a full payment that arrived after the window ambiguous, not settled", () => {
    // The case that looks like success. The rate it was priced at is no longer the rate, so this needs a
    // person who can see both sides rather than an automatic grant.
    const settled = { amount: money(5_120_000, "USDT"), at: new Date("2026-10-07T12:15:01.000Z") };

    expect(quoteVerdict(quote, settled, new Date("2026-10-07T12:16:00.000Z"))).toBe("AMBIGUOUS");
  });

  it("calls a payment in an asset nobody quoted ambiguous, and invents no exchange rate", () => {
    const settled = { amount: money(5_120_000, "BTC"), at: new Date("2026-10-07T12:10:00.000Z") };

    expect(quoteVerdict(quote, settled, new Date("2026-10-07T12:11:00.000Z"))).toBe("AMBIGUOUS");
  });

  it("still checks the amount when there is no clock on the charge", () => {
    // The ordinary card case: a fixed catalogue price in the catalogue's own currency. The amount
    // question is the same question, which is why there is not a second path that answers it.
    const fixed: PaymentQuote = { base: money(4900, "EUR"), charge: money(4900, "EUR"), quotedAt };

    expect(quoteVerdict(fixed, { amount: money(4900, "EUR"), at: new Date("2027-01-01T00:00:00.000Z") }, at2026)).toBe("SETTLED");
    expect(quoteVerdict(fixed, { amount: money(4899, "EUR"), at: quotedAt }, at2026)).toBe("UNDERPAID");
    expect(quoteVerdict(fixed, undefined, at2026)).toBe("PENDING");
  });
});

describe("when a term bought now ends", () => {
  it("adds a calendar month, not thirty days", () => {
    expect(periodEndFor("MONTH", new Date("2026-01-15T09:30:00.000Z")).toISOString()).toBe("2026-02-15T09:30:00.000Z");
    expect(periodEndFor("YEAR", new Date("2026-01-15T09:30:00.000Z")).toISOString()).toBe("2027-01-15T09:30:00.000Z");
  });

  it("clamps the day of month rather than rolling into the next month", () => {
    expect(periodEndFor("MONTH", new Date("2026-01-31T00:00:00.000Z")).toISOString()).toBe("2026-02-28T00:00:00.000Z");
    expect(periodEndFor("MONTH", new Date("2026-08-31T00:00:00.000Z")).toISOString()).toBe("2026-09-30T00:00:00.000Z");
    // A leap year, so February has a 29th to clamp to.
    expect(periodEndFor("MONTH", new Date("2028-01-31T00:00:00.000Z")).toISOString()).toBe("2028-02-29T00:00:00.000Z");
    expect(periodEndFor("YEAR", new Date("2028-02-29T00:00:00.000Z")).toISOString()).toBe("2029-02-28T00:00:00.000Z");
  });

  it("crosses a year boundary", () => {
    expect(periodEndFor("MONTH", new Date("2026-12-10T12:00:00.000Z")).toISOString()).toBe("2027-01-10T12:00:00.000Z");
  });
});

describe("what an event may do to a paid entitlement", () => {
  const at = new Date("2026-10-07T12:30:00.000Z");

  it("activates on a settled payment and extends on a renewal", () => {
    expect(entitlementEffectOf({ kind: "PAYMENT_SETTLED", route: directPsp(), at })).toEqual({ effect: "ACTIVATE" });
    expect(entitlementEffectOf({ kind: "SUBSCRIPTION_RENEWED", route: directPsp(), at })).toEqual({ effect: "EXTEND" });
  });

  it("suspends rather than ends on a failed payment, because nothing is deleted to satisfy a limit", () => {
    expect(entitlementEffectOf({ kind: "PAYMENT_FAILED", route: directPsp(), at })).toEqual({ effect: "SUSPEND" });
  });

  it("ends on a cancellation, a refund and a chargeback alike", () => {
    for (const kind of ["SUBSCRIPTION_CANCELED", "REFUNDED", "CHARGEBACK"] as const) {
      expect(entitlementEffectOf({ kind, route: directPsp(), at }), kind).toEqual({ effect: "END" });
    }
  });

  it("does nothing on an underpayment or an expired quote", () => {
    expect(entitlementEffectOf({ kind: "PAYMENT_UNDERPAID", route: cryptoProcessor(), at })).toEqual({ effect: "NONE" });
    expect(entitlementEffectOf({ kind: "QUOTE_EXPIRED", route: cryptoProcessor(), at })).toEqual({ effect: "NONE" });
  });

  it("judges the quote itself rather than taking the provider's word for 'settled'", () => {
    const quotedAt = new Date("2026-10-07T12:00:00.000Z");
    const quote: PaymentQuote = { base: money(4900, "EUR"), charge: money(5_120_000, "USDT"), quotedAt, expiresAt: new Date("2026-10-07T12:15:00.000Z") };

    // An adapter reporting its own vocabulary: the money arrived, so it says settled. Short by one unit.
    expect(
      entitlementEffectOf({
        kind: "PAYMENT_SETTLED",
        route: cryptoProcessor(),
        quote,
        settled: { amount: money(5_119_999, "USDT"), at: new Date("2026-10-07T12:10:00.000Z") },
        at,
      }),
    ).toEqual({ effect: "NONE", quote: "UNDERPAID" });

    // In full, after the window. The one that looks like success.
    expect(
      entitlementEffectOf({
        kind: "PAYMENT_SETTLED",
        route: cryptoProcessor(),
        quote,
        settled: { amount: money(5_120_000, "USDT"), at: new Date("2026-10-07T12:20:00.000Z") },
        at,
      }),
    ).toEqual({ effect: "NONE", quote: "AMBIGUOUS" });

    // In full, in time.
    expect(
      entitlementEffectOf({
        kind: "PAYMENT_SETTLED",
        route: cryptoProcessor(),
        quote,
        settled: { amount: money(5_120_000, "USDT"), at: new Date("2026-10-07T12:10:00.000Z") },
        at,
      }),
    ).toEqual({ effect: "ACTIVATE", quote: "SETTLED" });
  });

  it("still reverses on a chargeback whose quote expired, because the money left regardless", () => {
    const quote: PaymentQuote = {
      base: money(4900, "EUR"),
      charge: money(5_120_000, "USDT"),
      quotedAt: new Date("2026-10-07T12:00:00.000Z"),
      expiresAt: new Date("2026-10-07T12:15:00.000Z"),
    };

    expect(entitlementEffectOf({ kind: "CHARGEBACK", route: cryptoProcessor(), quote, at })).toEqual({ effect: "END", quote: "EXPIRED" });
  });

  it("lets nothing act on a route that can neither verify nor reconcile", () => {
    const unverifiable = directPsp({ capabilities: ["RECURRING_SUBSCRIPTIONS"] });

    for (const kind of BILLING_EVENT_KINDS) {
      expect(entitlementEffectOf({ kind, route: unverifiable, at }), kind).toEqual({ effect: "NONE" });
    }
  });

  it("has an effect for every event kind, so a new one cannot default to doing nothing unnoticed", () => {
    const silent = BILLING_EVENT_KINDS.filter((kind) => entitlementEffectOf({ kind, route: directPsp(), at }).effect === "NONE");

    // The two that mean "the money did not arrive as asked" are the only ones allowed to do nothing.
    expect(silent).toEqual(["PAYMENT_UNDERPAID", "QUOTE_EXPIRED"]);
  });
});

describe("which locale of a document to show", () => {
  it("prefers the exact tag", () => {
    expect(negotiateDocumentLocale("ru", ["en", "ru"], "en")).toBe("ru");
    expect(negotiateDocumentLocale("en-GB", ["en-GB", "en", "ru"], "en")).toBe("en-GB");
  });

  it("falls back to the same language in another region before changing language", () => {
    // `ru-RU` reads `ru`. Dropping to English here would hand somebody terms in a language they may not
    // read while a translation existed.
    expect(negotiateDocumentLocale("ru-RU", ["en", "ru"], "en")).toBe("ru");
    expect(negotiateDocumentLocale("pt", ["en", "pt-BR"], "en")).toBe("pt-BR");
  });

  it("falls back to the published language only when the requested one is absent", () => {
    expect(negotiateDocumentLocale("ru", ["en"], "en")).toBe("en");
    expect(negotiateDocumentLocale("de-AT", ["en", "ru"], "en")).toBe("en");
  });

  it("compares canonical tags, so two spellings of one tag do not miss each other", () => {
    expect(negotiateDocumentLocale("RU-ru", ["ru-RU"], "en")).toBe("ru-RU");
    expect(negotiateDocumentLocale("ru", ["RU"], "en")).toBe("RU");
  });

  it("returns nothing when even the fallback was never published", () => {
    // Which means nobody published that document at all, and the caller has to say so rather than
    // render a checkout with no terms on it.
    expect(negotiateDocumentLocale("ru", [], "en")).toBeUndefined();
    expect(negotiateDocumentLocale("ru", ["de"], "en")).toBeUndefined();
  });

  it("ignores a stored tag that is not a tag at all", () => {
    expect(negotiateDocumentLocale("ru", ["not a tag", "en"], "en")).toBe("en");
    expect(negotiateDocumentLocale("not a tag", ["en"], "en")).toBe("en");
  });

  it("says whether the reader got their own language", () => {
    expect(acceptedInOwnLanguage("ru", "ru")).toBe(true);
    expect(acceptedInOwnLanguage("ru-RU", "ru")).toBe(true);
    expect(acceptedInOwnLanguage("ru", "en")).toBe(false);
    expect(acceptedInOwnLanguage("en-GB", "en-US")).toBe(true);
  });
});

describe("legal acceptance", () => {
  it("names the kinds a checkout is still missing", () => {
    expect(missingAcceptances(["TERMS_OF_SERVICE", "PUBLIC_OFFER"], ["PUBLIC_OFFER"])).toEqual(["TERMS_OF_SERVICE"]);
    expect(missingAcceptances(["TERMS_OF_SERVICE", "REFUND_POLICY"], ["TERMS_OF_SERVICE"])).toEqual(["REFUND_POLICY"]);
    expect(missingAcceptances(["TERMS_OF_SERVICE"], ["TERMS_OF_SERVICE", "PRIVACY_POLICY"])).toEqual([]);
    expect(missingAcceptances([], [])).toEqual([]);
  });

  it("reports the missing kinds in the catalogue's own order, not the caller's", () => {
    expect(missingAcceptances([...LEGAL_DOCUMENT_KINDS].reverse(), [])).toEqual([...LEGAL_DOCUMENT_KINDS]);
  });
});
