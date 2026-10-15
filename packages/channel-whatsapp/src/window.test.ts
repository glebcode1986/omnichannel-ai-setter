/**
 * The customer-service window (#18).
 *
 * This is the file where WhatsApp stops resembling Instagram. Outside the 24 hours a conversation is not
 * closed, it is `TEMPLATE_ONLY` — an approved template may still reach the customer — and collapsing that
 * into `NOT_ELIGIBLE` would throw away the only business-initiated route the platform has.
 *
 * The other half of the contract is what this does *not* decide: whether to use that route. A transport
 * that chose when to message a customer would be making a product decision with no view of the policy,
 * the mode or the person's own wishes.
 */
import { describe, expect, it } from "vitest";

import { allowsFreeformSend } from "@omnichannel/channel-core";

import { DEFAULT_SERVICE_WINDOW_MS } from "./config";
import { evaluateServiceWindow, type WindowInputs } from "./window";

const NOW = new Date("2026-03-01T12:00:00.000Z");
const inputs: WindowInputs = { connectionState: "CONNECTED", serviceWindowMs: DEFAULT_SERVICE_WINDOW_MS };

const ctx = (lastInboundAt?: Date) => ({
  workspaceId: "ws_1",
  channelAccountId: "ca_1",
  conversationId: "cv_1",
  participantExternalId: "15550000002",
  ...(lastInboundAt === undefined ? {} : { lastInboundAt }),
  now: NOW,
});

describe("inside the 24 hours", () => {
  it("is open for free-form, and says when it closes", () => {
    const lastInbound = new Date(NOW.getTime() - 60_000);

    const decision = evaluateServiceWindow(ctx(lastInbound), inputs);

    expect(decision).toEqual({ state: "OPEN_FREEFORM", expiresAt: new Date(lastInbound.getTime() + DEFAULT_SERVICE_WINDOW_MS) });
    expect(allowsFreeformSend(decision, NOW)).toBe(true);
  });

  it("is open right up to the boundary and template-only after it", () => {
    const justInside = new Date(NOW.getTime() - DEFAULT_SERVICE_WINDOW_MS + 1_000);
    const justOutside = new Date(NOW.getTime() - DEFAULT_SERVICE_WINDOW_MS - 1_000);

    expect(evaluateServiceWindow(ctx(justInside), inputs).state).toBe("OPEN_FREEFORM");
    expect(evaluateServiceWindow(ctx(justOutside), inputs).state).toBe("TEMPLATE_ONLY");
  });
});

describe("outside the 24 hours", () => {
  it("is template-only rather than ineligible", () => {
    // The distinction is the product's: an approved template can still reach this customer, and the
    // policy layer decides whether to use one, hold the conversation or schedule it.
    const decision = evaluateServiceWindow(ctx(new Date(NOW.getTime() - 48 * 60 * 60 * 1000)), inputs);

    expect(decision).toEqual({ state: "TEMPLATE_ONLY" });
    // And automation still may not send free-form text, which is what the gate above it reads.
    expect(allowsFreeformSend(decision, NOW)).toBe(false);
  });

  it("is template-only when no customer message has ever arrived", () => {
    // A template is the documented way to start a conversation. NOT_ELIGIBLE here would mean the product
    // could never initiate anything, which is not what the platform says.
    expect(evaluateServiceWindow(ctx(), inputs)).toEqual({ state: "TEMPLATE_ONLY" });
  });
});

describe("when the connection is not usable", () => {
  it("is UNKNOWN, which fails closed for templates as well as for text", () => {
    for (const connectionState of ["NEEDS_REAUTH", "DISCONNECTED"] as const) {
      const decision = evaluateServiceWindow(ctx(new Date(NOW.getTime() - 60_000)), { ...inputs, connectionState });

      expect(decision).toEqual({ state: "UNKNOWN", reason: "channel account is not connected" });
      expect(allowsFreeformSend(decision, NOW)).toBe(false);
    }
  });
});

describe("the window inputs", () => {
  it("need no credentials to answer, so asking is not the same as being able to send", () => {
    // The type is a `Pick` of the adapter config for this reason: a caller that wants to know whether a
    // reply is still permitted should not have to hold the means to send one.
    const minimal: WindowInputs = { connectionState: "CONNECTED", serviceWindowMs: 1_000 };

    expect(evaluateServiceWindow(ctx(new Date(NOW.getTime() - 500)), minimal).state).toBe("OPEN_FREEFORM");
    expect(evaluateServiceWindow(ctx(new Date(NOW.getTime() - 2_000)), minimal).state).toBe("TEMPLATE_ONLY");
  });
});
