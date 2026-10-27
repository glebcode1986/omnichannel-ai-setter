/**
 * The Stripe adapter, against a scripted transport (Issue #41).
 *
 * No network, no key and no charge: the HTTP port is the seam, so every case here is the adapter's own
 * decisions — which route a delivery belongs to, what a Stripe object means, what it sends and what it
 * refuses to invent. The acceptance matrix the issue asks for lives here and in
 * `signature.test.ts`; duplicate and reordered *recording* is the store's, and is proved against a real
 * database in `packages/db/src/billing-routing.integration.test.ts`.
 *
 * Every secret and identifier below is invented.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createStripeBillingAdapter, STRIPE_PROVIDER } from "./adapter";
import { STRIPE_API_VERSION, StripeCallFailed } from "./api";
import { CONTRACT_METADATA_KEY } from "./events";
import type { BillingHttpPort, BillingHttpRequest, BillingHttpResult } from "./transport";

const UA_ROUTE = { routeCode: "stripe-ua-fop", secretKey: "rk_test_ua_fop", webhookSecrets: ["whsec_ua_fop"] };
const RO_ROUTE = { routeCode: "stripe-ro-company", secretKey: "rk_test_ro_company", webhookSecrets: ["whsec_ro_company"] };

const NOW = new Date("2026-10-12T12:00:00.000Z");
const CONTRACT = "ckc_01JQ8Z7Y3P";
const MS_PER_SECOND = 1_000;
const seconds = (instant: Date) => Math.floor(instant.getTime() / MS_PER_SECOND);

/** A transport that answers from a script and records what it was asked. */
function scripted(answers: readonly BillingHttpResult[]): { readonly port: BillingHttpPort; readonly sent: BillingHttpRequest[] } {
  const sent: BillingHttpRequest[] = [];
  let index = 0;
  return {
    sent,
    port: {
      send(request) {
        sent.push(request);
        const answer = answers[index] ?? answers[answers.length - 1];
        index += 1;
        if (answer === undefined) {
          throw new Error("the test script ran out of answers");
        }
        return Promise.resolve(answer);
      },
    },
  };
}

const ok = (body: unknown, requestId = "req_test_1"): BillingHttpResult => ({
  kind: "RESPONSE",
  status: 200,
  body: JSON.stringify(body),
  requestId,
});

const adapter = (answers: readonly BillingHttpResult[] = [ok({})], routes = [UA_ROUTE, RO_ROUTE]) => {
  const transport = scripted(answers);
  return { ...transport, subject: createStripeBillingAdapter({ routes, http: transport.port, now: () => NOW }) };
};

/** A signed delivery, exactly as Stripe sends one: `t=…,v1=hex(HMAC(secret, "t.body"))`. */
const delivery = (secret: string, event: unknown, at = NOW) => {
  const body = JSON.stringify(event);
  const t = seconds(at);
  const signature = createHmac("sha256", secret).update(`${String(t)}.${body}`, "utf8").digest("hex");
  return { provider: STRIPE_PROVIDER, body, headers: { "stripe-signature": `t=${String(t)},v1=${signature}` }, receivedAt: at };
};

const checkoutCompleted = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  id: "evt_checkout_1",
  object: "event",
  type: "checkout.session.completed",
  created: seconds(NOW),
  data: {
    object: {
      id: "cs_test_1",
      object: "checkout.session",
      mode: "subscription",
      payment_status: "paid",
      status: "complete",
      amount_total: 4_900,
      currency: "eur",
      client_reference_id: CONTRACT,
      subscription: "sub_test_1",
      ...overrides,
    },
  },
});

const invoicePaid = (reason: string, overrides: Readonly<Record<string, unknown>> = {}) => ({
  id: `evt_invoice_${reason}`,
  object: "event",
  type: "invoice.paid",
  created: seconds(NOW),
  data: {
    object: {
      id: "in_test_1",
      object: "invoice",
      billing_reason: reason,
      amount_paid: 4_900,
      currency: "eur",
      status: "paid",
      parent: {
        type: "subscription_details",
        subscription_details: { subscription: "sub_test_1", metadata: { [CONTRACT_METADATA_KEY]: CONTRACT } },
      },
      ...overrides,
    },
  },
});

const subscription = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  id: "sub_test_1",
  object: "subscription",
  status: "active",
  cancel_at_period_end: false,
  customer: "cus_test_1",
  currency: "eur",
  metadata: { [CONTRACT_METADATA_KEY]: CONTRACT },
  items: {
    object: "list",
    data: [{ id: "si_1", object: "subscription_item", current_period_end: seconds(new Date("2026-11-12T12:00:00.000Z")) }],
  },
  ...overrides,
});

describe("verifying and normalizing a Stripe delivery", () => {
  it("reads a completed checkout as a settlement attributed to its contract", async () => {
    const { subject } = adapter();

    const verified = await subject.verify(delivery(UA_ROUTE.webhookSecrets[0] ?? "", checkoutCompleted()));

    expect(verified).toEqual({
      kind: "EVENT",
      event: {
        routeCode: UA_ROUTE.routeCode,
        providerEventId: "evt_checkout_1",
        kind: "PAYMENT_SETTLED",
        occurredAt: NOW,
        checkoutContractId: CONTRACT,
        settled: { amountMinor: 4_900, currency: "EUR" },
        providerReference: "sub_test_1",
      },
    });
  });

  it("decides the route from the secret that authenticated the delivery, not from anything in it", async () => {
    // The isolation case the issue asks for, and the forged-route one at the same time. The body below
    // claims the other seller's route in every way a payload could; the only thing that decides is which
    // configured signing secret verifies it, and an attacker has neither.
    const { subject } = adapter();
    const forged = {
      ...checkoutCompleted(),
      route_code: RO_ROUTE.routeCode,
      account: "acct_the_other_seller",
      data: { object: { ...checkoutCompleted().data.object, metadata: { route_code: RO_ROUTE.routeCode } } },
    };

    const signedByUa = await subject.verify(delivery(UA_ROUTE.webhookSecrets[0] ?? "", forged));
    const signedByRo = await subject.verify(delivery(RO_ROUTE.webhookSecrets[0] ?? "", forged));

    expect(signedByUa).toMatchObject({ kind: "EVENT", event: { routeCode: UA_ROUTE.routeCode } });
    expect(signedByRo).toMatchObject({ kind: "EVENT", event: { routeCode: RO_ROUTE.routeCode } });
    // And a secret belonging to neither route authenticates nothing at all.
    expect(await subject.verify(delivery("whsec_not_ours", forged))).toBeNull();
  });

  it("refuses an unsigned, wrongly signed or stale delivery", async () => {
    const { subject } = adapter();
    const event = checkoutCompleted();
    const signed = delivery(UA_ROUTE.webhookSecrets[0] ?? "", event);

    expect(await subject.verify({ ...signed, headers: {} })).toBeNull();
    expect(await subject.verify({ ...signed, headers: { "stripe-signature": "t=1,v1=deadbeef" } })).toBeNull();
    // Signed correctly for a timestamp six minutes old, which is outside the documented tolerance.
    const stale = delivery(UA_ROUTE.webhookSecrets[0] ?? "", event, new Date(NOW.getTime() - 6 * 60_000));
    expect(await subject.verify({ ...stale, receivedAt: NOW })).toBeNull();
  });

  it("finds the signature header whatever case the runtime gave it", async () => {
    const { subject } = adapter();
    const signed = delivery(UA_ROUTE.webhookSecrets[0] ?? "", checkoutCompleted());
    const header = signed.headers["stripe-signature"] ?? "";

    expect(await subject.verify({ ...signed, headers: { "Stripe-Signature": header } })).toMatchObject({ kind: "EVENT" });
  });

  it("reports the same event identifier for a redelivery, which is what makes the store idempotent", async () => {
    // Stripe signs each attempt afresh, so the two deliveries differ in every byte of their header and
    // agree on the one thing idempotency is keyed on.
    const { subject } = adapter();
    const event = checkoutCompleted();

    const first = await subject.verify(delivery(UA_ROUTE.webhookSecrets[0] ?? "", event, new Date(NOW.getTime() - 60_000)));
    const second = await subject.verify(delivery(UA_ROUTE.webhookSecrets[0] ?? "", event));

    expect(first).toEqual(second);
  });

  it("treats an authentic event it does not map as acknowledged, not as a forgery", async () => {
    const { subject } = adapter();
    const unmapped = { id: "evt_pm_1", object: "event", type: "payment_method.attached", created: seconds(NOW), data: { object: { id: "pm_1" } } };

    // Authentic, and nothing for the product. A refusal here would make Stripe redeliver for three days.
    expect(await subject.verify(delivery(UA_ROUTE.webhookSecrets[0] ?? "", unmapped))).toEqual({ kind: "NO_EVENT" });
  });

  it("says nothing about a scheduled cancellation, because the customer has not lost anything yet", async () => {
    const { subject } = adapter();
    const scheduled = {
      id: "evt_sub_updated_1",
      object: "event",
      type: "customer.subscription.updated",
      created: seconds(NOW),
      data: { object: subscription({ cancel_at_period_end: true }) },
    };

    // The period they paid for is still running. The end arrives as `customer.subscription.deleted`.
    expect(await subject.verify(delivery(UA_ROUTE.webhookSecrets[0] ?? "", scheduled))).toEqual({ kind: "NO_EVENT" });
  });

  it("reads the end of a subscription as the end of the arrangement", async () => {
    const { subject } = adapter();
    const deleted = {
      id: "evt_sub_deleted_1",
      object: "event",
      type: "customer.subscription.deleted",
      created: seconds(NOW),
      data: { object: subscription({ status: "canceled" }) },
    };

    expect(await subject.verify(delivery(UA_ROUTE.webhookSecrets[0] ?? "", deleted))).toMatchObject({
      kind: "EVENT",
      event: { kind: "SUBSCRIPTION_CANCELED", checkoutContractId: CONTRACT, providerReference: "sub_test_1" },
    });
  });

  it("separates the first invoice of a subscription from every renewal after it", async () => {
    const { subject } = adapter();

    const created = await subject.verify(delivery(UA_ROUTE.webhookSecrets[0] ?? "", invoicePaid("subscription_create")));
    const cycled = await subject.verify(delivery(UA_ROUTE.webhookSecrets[0] ?? "", invoicePaid("subscription_cycle")));

    // The first invoice is the same money the checkout reported, so it settles — which means a lost
    // checkout event still activates. Every later one extends a period rather than starting one.
    expect(created).toMatchObject({ kind: "EVENT", event: { kind: "PAYMENT_SETTLED", checkoutContractId: CONTRACT } });
    expect(cycled).toMatchObject({ kind: "EVENT", event: { kind: "SUBSCRIPTION_RENEWED", checkoutContractId: CONTRACT } });
  });

  it("attributes a renewal from the subscription metadata snapshot, which is the only thing that carries it", async () => {
    // The store resolves an arrangement from the event's own id or from the contract it names, and from
    // nothing else — so a renewal whose metadata is missing can only be reported as nothing. Inventing an
    // attribution would charge the wrong workspace's month to the right one.
    const { subject } = adapter();
    const withoutMetadata = invoicePaid("subscription_cycle", {
      parent: { type: "subscription_details", subscription_details: { subscription: "sub_test_1", metadata: {} } },
    });
    const withoutParent = invoicePaid("subscription_cycle", { parent: null });

    expect(await subject.verify(delivery(UA_ROUTE.webhookSecrets[0] ?? "", withoutMetadata))).toEqual({ kind: "NO_EVENT" });
    expect(await subject.verify(delivery(UA_ROUTE.webhookSecrets[0] ?? "", withoutParent))).toEqual({ kind: "NO_EVENT" });
  });

  it("reads a failed invoice as a failure, which suspends rather than ends", async () => {
    const { subject } = adapter();
    const failed = { ...invoicePaid("subscription_cycle"), id: "evt_invoice_failed", type: "invoice.payment_failed" };

    expect(await subject.verify(delivery(UA_ROUTE.webhookSecrets[0] ?? "", failed))).toMatchObject({
      kind: "EVENT",
      event: { kind: "PAYMENT_FAILED", checkoutContractId: CONTRACT },
    });
  });

  it("waits for a delayed payment method to clear instead of settling on completion", async () => {
    const { subject } = adapter();
    const pending = checkoutCompleted({ payment_status: "unpaid" });
    const cleared = {
      ...checkoutCompleted(),
      id: "evt_async_ok",
      type: "checkout.session.async_payment_succeeded",
    };

    expect(await subject.verify(delivery(UA_ROUTE.webhookSecrets[0] ?? "", pending))).toEqual({ kind: "NO_EVENT" });
    expect(await subject.verify(delivery(UA_ROUTE.webhookSecrets[0] ?? "", cleared))).toMatchObject({
      kind: "EVENT",
      event: { kind: "PAYMENT_SETTLED" },
    });
  });

  it("settles a trial, where Stripe says no payment is required", async () => {
    // A zero-amount trial is an entitlement somebody was granted; the money and the entitlement are
    // different questions. `no_payment_required` is Stripe's word for it, and treating it as pending
    // would leave a paying-in-future customer with nothing switched on.
    const { subject } = adapter();
    const trial = checkoutCompleted({ payment_status: "no_payment_required", amount_total: 0 });

    expect(await subject.verify(delivery(UA_ROUTE.webhookSecrets[0] ?? "", trial))).toMatchObject({
      kind: "EVENT",
      event: { kind: "PAYMENT_SETTLED", settled: { amountMinor: 0, currency: "EUR" } },
    });
    // And a value nobody has written a rule for is not a settlement, because the check is an allowlist.
    const unknown = checkoutCompleted({ payment_status: "something_new" });
    expect(await subject.verify(delivery(UA_ROUTE.webhookSecrets[0] ?? "", unknown))).toEqual({ kind: "NO_EVENT" });
  });

  it("reads an expired checkout as an expired quote, and ignores a session this product did not open", async () => {
    const { subject } = adapter();
    const expired = { ...checkoutCompleted(), id: "evt_expired", type: "checkout.session.expired" };
    const foreign = { ...checkoutCompleted(), id: "evt_foreign", data: { object: { ...checkoutCompleted().data.object, client_reference_id: null } } };

    expect(await subject.verify(delivery(UA_ROUTE.webhookSecrets[0] ?? "", expired))).toMatchObject({
      kind: "EVENT",
      event: { kind: "QUOTE_EXPIRED", checkoutContractId: CONTRACT },
    });
    expect(await subject.verify(delivery(UA_ROUTE.webhookSecrets[0] ?? "", foreign))).toEqual({ kind: "NO_EVENT" });
  });

  it("refuses an authentic body it cannot read as an event", async () => {
    const { subject } = adapter();
    const signAndSend = (body: string) => {
      const t = seconds(NOW);
      const signature = createHmac("sha256", UA_ROUTE.webhookSecrets[0] ?? "").update(`${String(t)}.${body}`, "utf8").digest("hex");
      return subject.verify({ provider: STRIPE_PROVIDER, body, headers: { "stripe-signature": `t=${String(t)},v1=${signature}` }, receivedAt: NOW });
    };

    // Refused rather than acknowledged: Stripe signed something this adapter cannot parse, which somebody
    // has to see. An acknowledgement would discard it silently.
    expect(await signAndSend("not json at all")).toBeNull();
    expect(await signAndSend(JSON.stringify({ object: "event" }))).toBeNull();
    expect(await signAndSend(JSON.stringify({ id: "evt_1", type: "invoice.paid", created: seconds(NOW) }))).toBeNull();
  });
});

describe("opening a checkout", () => {
  it("asks Stripe for a subscription session carrying the contract in both places it is needed", async () => {
    const { subject, sent } = adapter([ok({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" })]);

    const handoff = await subject.openCheckout?.({
      routeCode: UA_ROUTE.routeCode,
      arrangement: "RECURRING",
      amountMinor: 4_900,
      currency: "EUR",
      priceReference: "price_growth_eur_month",
      clientReference: CONTRACT,
      successUrl: "https://app.test/billing/success",
      cancelUrl: "https://app.test/billing",
    });

    // The session id comes back so the contract can record which session it was handed to, once.
    expect(handoff).toEqual({ kind: "REDIRECT", url: "https://checkout.stripe.com/c/pay/cs_test_1", reference: "cs_test_1" });
    const request = sent[0];
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(request?.headers["authorization"]).toBe(`Bearer ${UA_ROUTE.secretKey}`);
    // Pinned, so a monthly API release cannot reshape what this adapter parses.
    expect(request?.headers["stripe-version"]).toBe(STRIPE_API_VERSION);
    // Deterministic on the contract: a retried request returns the first session rather than opening a
    // second charge path for the same contract.
    expect(request?.headers["idempotency-key"]).toBe(`checkout:${CONTRACT}`);
    const fields = new URLSearchParams(request?.body ?? "");
    expect(fields.get("mode")).toBe("subscription");
    expect(fields.get("line_items[0][price]")).toBe("price_growth_eur_month");
    expect(fields.get("line_items[0][quantity]")).toBe("1");
    expect(fields.get("client_reference_id")).toBe(CONTRACT);
    // On the subscription too, because a renewal event carries the subscription's metadata and nothing
    // else that could attribute it.
    expect(fields.get(`subscription_data[metadata][${CONTRACT_METADATA_KEY}]`)).toBe(CONTRACT);
  });

  it("asks for a one-off payment, and no subscription metadata, for a prepaid term", async () => {
    const { subject, sent } = adapter([ok({ id: "cs_test_2", url: "https://checkout.stripe.com/c/pay/cs_test_2" })]);

    await subject.openCheckout?.({
      routeCode: UA_ROUTE.routeCode,
      arrangement: "PREPAID_TERM",
      amountMinor: 4_900,
      currency: "EUR",
      priceReference: "price_growth_eur_month",
      clientReference: CONTRACT,
      successUrl: "https://app.test/billing/success",
      cancelUrl: "https://app.test/billing",
    });

    const fields = new URLSearchParams(sent[0]?.body ?? "");
    expect(fields.get("mode")).toBe("payment");
    expect(fields.has(`subscription_data[metadata][${CONTRACT_METADATA_KEY}]`)).toBe(false);
  });

  it("uses the secret key of the route it was asked for, and refuses a route this process has not got", async () => {
    const { subject, sent } = adapter([ok({ id: "cs_test_3", url: "https://checkout.stripe.com/c/pay/cs_test_3" })]);
    const request = {
      arrangement: "RECURRING" as const,
      amountMinor: 4_900,
      currency: "EUR",
      priceReference: "price_growth_eur_month",
      clientReference: CONTRACT,
      successUrl: "https://app.test/billing/success",
      cancelUrl: "https://app.test/billing",
    };

    await subject.openCheckout?.({ ...request, routeCode: RO_ROUTE.routeCode });
    expect(sent[0]?.headers["authorization"]).toBe(`Bearer ${RO_ROUTE.secretKey}`);

    await expect(subject.openCheckout?.({ ...request, routeCode: "stripe-not-configured" })).rejects.toBeInstanceOf(StripeCallFailed);
    // Nothing was asked of Stripe, so there is no status to report and no second request.
    expect(sent).toHaveLength(1);
  });

  it("reports a provider timeout as a retryable failure rather than as a hand-off", async () => {
    const { subject } = adapter([{ kind: "NO_RESPONSE", reason: "TIMEOUT" }]);

    const failure = await subject
      .openCheckout?.({
        routeCode: UA_ROUTE.routeCode,
        arrangement: "RECURRING",
        amountMinor: 4_900,
        currency: "EUR",
        priceReference: "price_growth_eur_month",
        clientReference: CONTRACT,
        successUrl: "https://app.test/billing/success",
        cancelUrl: "https://app.test/billing",
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(StripeCallFailed);
    expect(failure).toMatchObject({ kind: "TIMEOUT", retryable: true });
  });

  it("carries Stripe's codes out of a rejection and none of its prose", async () => {
    const { subject } = adapter([
      {
        kind: "RESPONSE",
        status: 400,
        body: JSON.stringify({
          error: {
            type: "invalid_request_error",
            code: "resource_missing",
            message: "No such price: 'price_nope'; a message that must not travel",
            request_log_url: "https://dashboard.stripe.com/test/logs/req_1",
          },
        }),
        requestId: "req_rejected_1",
      },
    ]);

    const failure = (await subject
      .openCheckout?.({
        routeCode: UA_ROUTE.routeCode,
        arrangement: "RECURRING",
        amountMinor: 4_900,
        currency: "EUR",
        priceReference: "price_nope",
        clientReference: CONTRACT,
        successUrl: "https://app.test/billing/success",
        cancelUrl: "https://app.test/billing",
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      )) as StripeCallFailed | undefined;

    expect(failure?.kind).toBe("REJECTED");
    expect(failure?.detail).toEqual({ status: 400, errorType: "invalid_request_error", errorCode: "resource_missing", requestId: "req_rejected_1" });
    // A wrong request is not a transient fault, so repeating it would repeat the mistake.
    expect(failure?.retryable).toBe(false);
    // The caller logs what it is given, so what it is given may not contain the provider's prose, a
    // dashboard link, or anything about the key.
    expect(failure?.message).not.toContain("must not travel");
    expect(failure?.message).not.toContain("dashboard.stripe.com");
    expect(failure?.message).not.toContain(UA_ROUTE.secretKey);
    expect(failure?.message).toContain("req_rejected_1");
  });

  it("treats throttling and Stripe's own errors as worth retrying", async () => {
    for (const status of [429, 500, 503]) {
      const { subject } = adapter([{ kind: "RESPONSE", status, body: JSON.stringify({ error: { type: "api_error" } }) }]);

      const failure = (await subject
        .openCheckout?.({
          routeCode: UA_ROUTE.routeCode,
          arrangement: "RECURRING",
          amountMinor: 4_900,
          currency: "EUR",
          priceReference: "price_growth_eur_month",
          clientReference: CONTRACT,
          successUrl: "https://app.test/billing/success",
          cancelUrl: "https://app.test/billing",
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        )) as StripeCallFailed | undefined;

      expect(failure?.retryable, `status ${String(status)}`).toBe(true);
    }
  });

  it("takes Stripe's own retry guidance over the status code", async () => {
    // The header is documented as guidance the status code does not carry. A 400 Stripe says to retry is
    // worth retrying, and a 500 it says not to is not — so a status-code table that overrode it would be
    // preferring a guess to a fact.
    const checkout = {
      routeCode: UA_ROUTE.routeCode,
      arrangement: "RECURRING" as const,
      amountMinor: 4_900,
      currency: "EUR",
      priceReference: "price_growth_eur_month",
      clientReference: CONTRACT,
      successUrl: "https://app.test/billing/success",
      cancelUrl: "https://app.test/billing",
    };
    const failureFor = async (result: BillingHttpResult) => {
      const { subject } = adapter([result]);
      return (await subject.openCheckout?.(checkout).then(
        () => undefined,
        (error: unknown) => error,
      )) as StripeCallFailed | undefined;
    };

    expect(
      (await failureFor({ kind: "RESPONSE", status: 400, body: "{}", shouldRetry: true }))?.retryable,
      "a 400 the provider says to retry",
    ).toBe(true);
    expect(
      (await failureFor({ kind: "RESPONSE", status: 500, body: "{}", shouldRetry: false }))?.retryable,
      "a 500 the provider says not to retry",
    ).toBe(false);
    // Absent, and the status code decides as before.
    expect((await failureFor({ kind: "RESPONSE", status: 400, body: "{}" }))?.retryable).toBe(false);
  });

  it("refuses a session with no hosted page instead of redirecting a customer nowhere", async () => {
    const { subject } = adapter([ok({ id: "cs_test_4" })]);

    await expect(
      subject.openCheckout?.({
        routeCode: UA_ROUTE.routeCode,
        arrangement: "RECURRING",
        amountMinor: 4_900,
        currency: "EUR",
        priceReference: "price_growth_eur_month",
        clientReference: CONTRACT,
        successUrl: "https://app.test/billing/success",
        cancelUrl: "https://app.test/billing",
      }),
    ).rejects.toMatchObject({ kind: "UNREADABLE" });
  });
});

describe("the provider-hosted management page", () => {
  it("resolves the customer from the stored subscription and opens a portal session", async () => {
    const { subject, sent } = adapter([ok(subscription()), ok({ id: "bps_1", url: "https://billing.stripe.com/p/session?secret=test" })]);

    const handoff = await subject.openManagementSession?.({
      routeCode: UA_ROUTE.routeCode,
      providerReference: "sub_test_1",
      returnUrl: "https://app.test/billing",
      locale: "ru",
    });

    expect(handoff).toEqual({ kind: "REDIRECT", url: "https://billing.stripe.com/p/session?secret=test" });
    expect(sent[0]).toMatchObject({ method: "GET", url: "https://api.stripe.com/v1/subscriptions/sub_test_1" });
    expect(sent[1]?.url).toBe("https://api.stripe.com/v1/billing_portal/sessions");
    const fields = new URLSearchParams(sent[1]?.body ?? "");
    expect(fields.get("customer")).toBe("cus_test_1");
    expect(fields.get("return_url")).toBe("https://app.test/billing");
    expect(fields.get("locale")).toBe("ru");
    // A portal session is a short-lived page; replaying the first one for every later visit is the
    // opposite of what "manage billing" means.
    expect(sent[1]?.headers["idempotency-key"]).toBeUndefined();
  });

  it("refuses when the subscription says nothing about a customer", async () => {
    const { subject } = adapter([ok(subscription({ customer: null }))]);

    await expect(
      subject.openManagementSession?.({ routeCode: UA_ROUTE.routeCode, providerReference: "sub_test_1", returnUrl: "https://app.test/billing" }),
    ).rejects.toMatchObject({ kind: "UNREADABLE" });
  });
});

describe("stopping and restarting a renewal", () => {
  it("schedules the end of the paid period rather than cancelling immediately", async () => {
    const { subject, sent } = adapter([ok(subscription({ cancel_at_period_end: true }))]);

    const state = await subject.setRenewal?.({ routeCode: UA_ROUTE.routeCode, providerReference: "sub_test_1", renew: false });

    expect(sent[0]).toMatchObject({ method: "POST", url: "https://api.stripe.com/v1/subscriptions/sub_test_1" });
    expect(new URLSearchParams(sent[0]?.body ?? "").get("cancel_at_period_end")).toBe("true");
    // The customer keeps what they paid for, and the period end is read from where the current API keeps
    // it — on the subscription's items, not on the subscription.
    expect(state).toEqual({ renews: false, periodEndsAt: new Date("2026-11-12T12:00:00.000Z") });
  });

  it("restarts a renewal that was scheduled to stop", async () => {
    const { subject, sent } = adapter([ok(subscription({ cancel_at_period_end: false }))]);

    const state = await subject.setRenewal?.({ routeCode: UA_ROUTE.routeCode, providerReference: "sub_test_1", renew: true });

    expect(new URLSearchParams(sent[0]?.body ?? "").get("cancel_at_period_end")).toBe("false");
    expect(state).toMatchObject({ renews: true });
  });

  it("reads a scheduled end from `cancel_at`, which is where the default billing mode puts it", async () => {
    // New subscriptions use the `flexible` billing mode, and Stripe's own guidance is to confirm a
    // reactivation there by checking that `cancel_at` is null — `cancel_at_period_end` is the field that
    // carries it only in `classic` mode. A reader of one field is right in one mode and wrong in the
    // other, and the wrong direction loses somebody their automation without warning.
    const { subject } = adapter([ok(subscription({ cancel_at_period_end: false, cancel_at: seconds(new Date("2026-11-12T12:00:00.000Z")) }))]);

    expect(await subject.setRenewal?.({ routeCode: UA_ROUTE.routeCode, providerReference: "sub_test_1", renew: true })).toMatchObject({
      renews: false,
    });
  });

  it("reports a renewal only when neither field names an end", async () => {
    const { subject } = adapter([ok(subscription({ cancel_at_period_end: false, cancel_at: null }))]);

    expect(await subject.setRenewal?.({ routeCode: UA_ROUTE.routeCode, providerReference: "sub_test_1", renew: true })).toMatchObject({
      renews: true,
    });
  });

  it("reports what the provider now says, not what the request asked for", async () => {
    // The provider is the authority. A request to resume that Stripe did not apply must not be reported
    // back as applied, or a screen would show a renewal nobody is going to be charged for.
    const { subject } = adapter([ok(subscription({ cancel_at_period_end: true }))]);

    expect(await subject.setRenewal?.({ routeCode: UA_ROUTE.routeCode, providerReference: "sub_test_1", renew: true })).toMatchObject({
      renews: false,
    });
  });
});

describe("reconciling against what Stripe says is true", () => {
  const reconcile = async (overrides: Readonly<Record<string, unknown>>) => {
    const { subject } = adapter([ok(subscription(overrides))]);
    return subject.reconcile?.({ routeCode: UA_ROUTE.routeCode, providerReference: "sub_test_1" });
  };

  it("reads a live subscription as a settlement, with the period Stripe states", async () => {
    expect(await reconcile({ status: "active" })).toEqual({
      routeCode: UA_ROUTE.routeCode,
      providerEventId: `stripe:reconcile:sub_test_1:active:${String(new Date("2026-11-12T12:00:00.000Z").getTime())}`,
      kind: "PAYMENT_SETTLED",
      occurredAt: NOW,
      checkoutContractId: CONTRACT,
      providerReference: "sub_test_1",
      periodEndsAt: new Date("2026-11-12T12:00:00.000Z"),
    });
  });

  it("gives one identifier per observation, so repairing twice repairs once", async () => {
    const unchanged = await reconcile({ status: "active" });
    const again = await reconcile({ status: "active" });
    const moved = await reconcile({
      status: "active",
      items: { object: "list", data: [{ current_period_end: Math.floor(new Date("2026-12-12T12:00:00.000Z").getTime() / 1_000) }] },
    });

    // The same observation is the same event, which the store then rejects as a duplicate; a new state or
    // a new period is a new event, which it must not mistake for the old one.
    expect(again?.providerEventId).toBe(unchanged?.providerEventId);
    expect(moved?.providerEventId).not.toBe(unchanged?.providerEventId);
  });

  it("maps every subscription state Stripe documents, and asserts nothing about the two that mean nothing yet", async () => {
    expect((await reconcile({ status: "trialing" }))?.kind).toBe("PAYMENT_SETTLED");
    expect((await reconcile({ status: "past_due" }))?.kind).toBe("PAYMENT_FAILED");
    expect((await reconcile({ status: "unpaid" }))?.kind).toBe("PAYMENT_FAILED");
    expect((await reconcile({ status: "canceled" }))?.kind).toBe("SUBSCRIPTION_CANCELED");
    // Terminal: the first invoice was never paid and never will be.
    expect((await reconcile({ status: "incomplete_expired" }))?.kind).toBe("SUBSCRIPTION_CANCELED");
    // Neither a settlement, a failure nor an ending — so reconciliation says nothing rather than guessing.
    expect(await reconcile({ status: "incomplete" })).toBeNull();
    expect(await reconcile({ status: "paused" })).toBeNull();
    // And a status nobody has written a rule for is the same answer, because the map is total rather than
    // a switch with a default.
    expect(await reconcile({ status: "something_stripe_added_later" })).toBeNull();
  });

  it("says nothing about a subscription this product cannot attribute", async () => {
    expect(await reconcile({ metadata: {} })).toBeNull();
  });

  it("reads the period from the subscription's items, which is where it now lives", async () => {
    // `current_period_end` is no longer a field on the subscription object. Reading the old place returns
    // nothing and silently loses every period end.
    const withOldShape = await reconcile({ items: { object: "list", data: [] }, current_period_end: seconds(new Date("2026-11-12T12:00:00.000Z")) });

    expect(withOldShape?.periodEndsAt).toBeUndefined();
    // More than one item: the arrangement ends when the last thing it pays for does.
    const multiple = await reconcile({
      items: {
        object: "list",
        data: [
          { current_period_end: Math.floor(new Date("2026-11-12T12:00:00.000Z").getTime() / 1_000) },
          { current_period_end: Math.floor(new Date("2026-12-12T12:00:00.000Z").getTime() / 1_000) },
        ],
      },
    });
    expect(multiple?.periodEndsAt).toEqual(new Date("2026-12-12T12:00:00.000Z"));
  });

  it("propagates a provider outage rather than reporting a state it did not read", async () => {
    const { subject } = adapter([{ kind: "NO_RESPONSE", reason: "NETWORK" }]);

    await expect(subject.reconcile?.({ routeCode: UA_ROUTE.routeCode, providerReference: "sub_test_1" })).rejects.toMatchObject({
      kind: "UNREACHABLE",
      retryable: true,
    });
  });
});
