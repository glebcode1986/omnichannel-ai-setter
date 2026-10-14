/**
 * The live channel facts the coordinator is given at send time.
 *
 * One of them is the provider's automated-response deadline, and who it applies to is a correctness
 * question rather than a tuning one: it encodes Meta's rule about answering a person *promptly*, counted
 * from their message. A send that answers nothing has no such message, and a deadline counted from a
 * message hours old is already spent — so applying it to a planned follow-up would turn the quiet-hours
 * gate into "ask a person" for every follow-up a business ever schedules (#55).
 *
 * These cases hold both halves in place: the deadline is still derived for a reply, and is absent for a
 * proactive send. Dropping either half is a silent change — one makes a feature unusable, the other loses
 * a provider rule — so neither is left to a comment.
 */
import type { DeliverySendContext } from "@omnichannel/application";
import { describe, expect, it } from "vitest";

import { createChannelStateResolver } from "./delivery-policy";

const NOW = new Date("2026-10-06T12:00:00.000Z");
/** Inside the 24-hour messaging window, and far outside the 25-second response budget. */
const LAST_INBOUND = new Date(NOW.getTime() - 20 * 60 * 60 * 1000);

const context = (overrides: Partial<DeliverySendContext> = {}): DeliverySendContext =>
  ({
    deliveryJobId: "djob_1",
    operationId: "op_1",
    workspaceId: "ws_1",
    draftId: "draft_1",
    conversationId: "conv_1",
    channel: "INSTAGRAM",
    recipientExternalId: "ig-user-1",
    channelAccountId: "ca_1",
    text: "Just checking in.",
    status: "SCHEDULED",
    attemptCount: 0,
    mode: "AUTOPILOT",
    aiEnabled: true,
    takeover: { state: "NONE" },
    replyCycle: "OWNED",
    account: "CONNECTED",
    draftNeedsReview: false,
    alreadySent: false,
    limits: { confidenceThreshold: 0.8, mandatoryReviewReasons: [] },
    lastInboundAt: LAST_INBOUND,
    authority: { kind: "AUTOMATED" },
    ...overrides,
  }) as DeliverySendContext;

describe("the provider deadline a send is held to", () => {
  const resolver = createChannelStateResolver(() => NOW);

  it("is derived from the customer's message for a reply that answers them", () => {
    const state = resolver.stateFor(context());

    // 25 seconds after their message, which is long past — the coordinator's business, not this file's.
    expect(state.dispatchDeadline).toEqual(new Date(LAST_INBOUND.getTime() + 25_000));
  });

  it("is absent for a send that answers nothing", () => {
    const state = resolver.stateFor(context({ proactive: true }));

    expect(state.dispatchDeadline).toBeUndefined();
    // The messaging window is not relaxed with it: it is still counted from the customer's own last
    // message, and a follow-up outside it is refused exactly as any other send would be.
    expect(state.window).toMatchObject({ state: "OPEN_FREEFORM", expiresAt: new Date(LAST_INBOUND.getTime() + 24 * 60 * 60 * 1000) });
  });

  it("stays absent when there is no customer message at all, proactive or not", () => {
    for (const proactive of [undefined, true]) {
      const state = resolver.stateFor(context({ ...(proactive === undefined ? {} : { proactive }), lastInboundAt: undefined }));
      expect(state.dispatchDeadline).toBeUndefined();
      // And with no message there is no window either, so nothing may be sent on this route.
      expect(state.window.state).not.toBe("OPEN_FREEFORM");
    }
  });
});
