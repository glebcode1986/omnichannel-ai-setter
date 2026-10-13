/**
 * The billing webhook transport, as HTTP reaches it (Issue #41).
 *
 * What is under test is the one decision this file owns: **what the provider is told.** An adapter that
 * could choose the status could answer `200` to a delivery the product refused, and a provider that hears
 * `200` stops retrying — so the three facts the port returns are mapped here, and each mapping has a way
 * of being wrong that costs something specific. Refusing an authentic event nobody will act on buys three
 * days of redelivery; acknowledging a forgery buys silence.
 *
 * `verify` and `record` are injected, so these cases need no registry and no database. The store's own
 * suite proves recording against a real one.
 */
import type { BillingEventResult, RawProviderDelivery, VerifiedBillingEvent, VerifiedProviderDelivery } from "@omnichannel/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createBillingWebhookHandler, MAX_BILLING_BODY_BYTES } from "./billing-webhooks";

const NOW = new Date("2026-10-12T12:00:00.000Z");
const BODY = '{"id":"evt_1","object":"event","type":"invoice.paid"}';

/** A minted event is unforgeable in production; here it only has to be the shape the route passes on. */
const EVENT = {
  routeCode: "stripe-ua-fop",
  providerEventId: "evt_1",
  kind: "PAYMENT_SETTLED",
  occurredAt: NOW,
  checkoutContractId: "ckc_1",
  activationSource: "VERIFIED_EVENT",
} as unknown as VerifiedBillingEvent;

const logged: { level: string; event: string; fields: Readonly<Record<string, unknown>> }[] = [];

const logger = () => {
  const record = (level: string) => (event: string, fields: Readonly<Record<string, unknown>> = {}) => {
    logged.push({ level, event, fields });
  };
  return { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") } as never;
};

const handler = (
  verified: VerifiedProviderDelivery | (() => Promise<VerifiedProviderDelivery>),
  result: BillingEventResult | (() => Promise<BillingEventResult>) = { outcome: "APPLIED", effect: "ACTIVATE" },
) => {
  const verify = vi.fn<(delivery: RawProviderDelivery) => Promise<VerifiedProviderDelivery>>(
    typeof verified === "function" ? verified : () => Promise.resolve(verified),
  );
  const record = vi.fn<(event: VerifiedBillingEvent) => Promise<BillingEventResult>>(
    typeof result === "function" ? result : () => Promise.resolve(result),
  );
  const ensureAdapters = vi.fn(() => {
    // Ordering, asserted by construction: a provider that is not registered refuses everything, and that
    // refusal is indistinguishable from a forgery. So registration must have happened before verifying.
    expect(verify).not.toHaveBeenCalled();
  });
  return {
    verify,
    record,
    ensureAdapters,
    handle: createBillingWebhookHandler({ provider: "stripe", verify, record, logger, newCorrelationId: () => "generated-correlation", ensureAdapters, now: () => NOW }),
  };
};

const post = (body: string, headers: Readonly<Record<string, string>> = {}) =>
  new Request("https://app.test/api/billing/webhooks/stripe", { method: "POST", body, headers: { "stripe-signature": "t=1,v1=abc", ...headers } });

beforeEach(() => {
  logged.length = 0;
});

describe("what the provider is told", () => {
  it("records an authentic event and acknowledges it", async () => {
    const subject = handler({ kind: "EVENT", event: EVENT });

    const response = await subject.handle(post(BODY));

    expect(response.status).toBe(200);
    expect(subject.ensureAdapters).toHaveBeenCalled();
    expect(subject.record).toHaveBeenCalledWith(EVENT);
    // The product's own vocabulary, so an operator reading the delivery log in Stripe's dashboard can see
    // what this side made of it.
    expect(await response.json()).toEqual({ status: "accepted", outcome: "APPLIED", effect: "ACTIVATE" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-correlation-id")).toBe("generated-correlation");
  });

  it("acknowledges an authentic event it has nothing to record, instead of asking for it again", async () => {
    const subject = handler({ kind: "ACKNOWLEDGED" });

    const response = await subject.handle(post(BODY));

    // A non-2xx here would buy three days of redelivery for an event nobody will ever act on.
    expect(response.status).toBe(200);
    expect(subject.record).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ status: "accepted" });
  });

  it("refuses a delivery the port would not authenticate, and records nothing", async () => {
    const subject = handler({ kind: "REFUSED" });

    const response = await subject.handle(post(BODY));

    expect(response.status).toBe(401);
    expect(subject.record).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ status: "unauthorized" });
  });

  it("returns the provider's own acknowledgement body when the adapter produced one", async () => {
    // Only the adapter holds the signing secret, so only the adapter can produce a signed reply — the
    // port carries it back rather than leaving this route to invent one.
    const subject = handler({ kind: "EVENT", event: EVENT, acknowledgement: { body: "signed-ack", headers: { "X-Provider-Ack": "1" } } });

    const response = await subject.handle(post(BODY));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("signed-ack");
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("x-provider-ack")).toBe("1");
  });

  it("acknowledges an event it has already dealt with, and one for a route it does not know", async () => {
    // A duplicate has been dealt with, and asking for it again for three days achieves nothing; an
    // unknown route is a configuration fact on this side, which the provider cannot fix by redelivering.
    for (const outcome of ["DUPLICATE", "UNKNOWN_ROUTE", "UNATTRIBUTED"]) {
      const subject = handler({ kind: "EVENT", event: EVENT }, { outcome, effect: "NONE" } as BillingEventResult);

      const response = await subject.handle(post(BODY));

      expect(response.status, outcome).toBe(200);
      expect(await response.json()).toMatchObject({ outcome });
    }
  });

  it("asks for the delivery again when recording failed", async () => {
    const subject = handler({ kind: "EVENT", event: EVENT }, () => Promise.reject(new Error("the database went away")));

    const response = await subject.handle(post(BODY));

    // Nothing was acknowledged, so Stripe retries — and recording is keyed on the provider's own event
    // id, so a retry after a crash mid-transaction cannot double-count.
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ status: "error" });
  });
});

describe("the bytes the signature was taken over", () => {
  it("hands the adapter the exact string it received", async () => {
    // Re-serializing parsed JSON reorders keys and strips whitespace, and the signature is over bytes.
    const awkward = '{\n  "type" : "invoice.paid",\n  "id":"evt_1"\n}';
    const subject = handler({ kind: "ACKNOWLEDGED" });

    await subject.handle(post(awkward));

    expect(subject.verify.mock.calls[0]?.[0]?.body).toBe(awkward);
  });

  it("passes the headers through, so the adapter can find the signature", async () => {
    const subject = handler({ kind: "ACKNOWLEDGED" });

    await subject.handle(post(BODY, { "stripe-signature": "t=7,v1=feedface" }));

    const delivery = subject.verify.mock.calls[0]?.[0];
    expect(delivery?.provider).toBe("stripe");
    expect(delivery?.headers["stripe-signature"]).toBe("t=7,v1=feedface");
    expect(delivery?.receivedAt).toEqual(NOW);
  });

  it("refuses an oversized body before reading it twice, and never verifies it", async () => {
    const subject = handler({ kind: "EVENT", event: EVENT });
    const huge = "x".repeat(MAX_BILLING_BODY_BYTES + 1);

    const declared = await subject.handle(post(huge, { "content-length": String(MAX_BILLING_BODY_BYTES + 1) }));
    expect(declared.status).toBe(413);

    // And when the declared length lies, the body itself is still measured.
    const undeclared = await subject.handle(post(huge, { "content-length": "10" }));
    expect(undeclared.status).toBe(413);
    expect(subject.verify).not.toHaveBeenCalled();
  });
});

describe("what gets written down", () => {
  it("logs the product's own facts and nothing from the payload", async () => {
    const subject = handler({ kind: "EVENT", event: EVENT });

    await subject.handle(post(BODY));

    const line = logged.find((entry) => entry.event === "billing.delivery_recorded");
    expect(line?.fields).toEqual({
      correlationId: "generated-correlation",
      provider: "stripe",
      routeCode: "stripe-ua-fop",
      outcome: "APPLIED",
      effect: "ACTIVATE",
    });
    // A billing payload names a customer, an amount and a provider account. None of it belongs in a log,
    // and neither does the provider's own event id — the audit row already holds that.
    const everything = JSON.stringify(logged);
    expect(everything).not.toContain("evt_1");
    expect(everything).not.toContain("ckc_1");
    expect(everything).not.toContain("v1=");
  });

  it("says a refusal at warn, because a run of them is a misconfigured secret or somebody probing", async () => {
    const subject = handler({ kind: "REFUSED" });

    await subject.handle(post(BODY));

    expect(logged).toEqual([{ level: "warn", event: "billing.delivery_refused", fields: { correlationId: "generated-correlation", provider: "stripe" } }]);
  });

  it("names only the error's type when recording failed", async () => {
    const subject = handler({ kind: "EVENT", event: EVENT }, () => Promise.reject(new Error("a message mentioning cus_12345")));

    await subject.handle(post(BODY));

    const line = logged.find((entry) => entry.event === "billing.delivery_failed");
    expect(line?.fields).toEqual({ correlationId: "generated-correlation", provider: "stripe", errorName: "Error" });
    expect(JSON.stringify(logged)).not.toContain("cus_12345");
  });

  it("follows a correlation id the caller supplied, and only one that looks like one", async () => {
    const subject = handler({ kind: "ACKNOWLEDGED" });

    const followed = await subject.handle(post(BODY, { "x-correlation-id": "req-from-the-edge-1" }));
    expect(followed.headers.get("x-correlation-id")).toBe("req-from-the-edge-1");

    // Anything else is replaced rather than echoed: a header is attacker-controlled, and it ends up in
    // every log line for this request.
    const rejected = await subject.handle(post(BODY, { "x-correlation-id": "short" }));
    expect(rejected.headers.get("x-correlation-id")).toBe("generated-correlation");
    // Spaces, so the value is a legal header and an illegal correlation id: what matters is that the
    // pattern decides, not that the transport happened to reject the bytes.
    const loose = await subject.handle(post(BODY, { "x-correlation-id": "an id with spaces in it" }));
    expect(loose.headers.get("x-correlation-id")).toBe("generated-correlation");
    const tooLong = await subject.handle(post(BODY, { "x-correlation-id": "a".repeat(129) }));
    expect(tooLong.headers.get("x-correlation-id")).toBe("generated-correlation");
  });
});
