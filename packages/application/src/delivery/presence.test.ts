/**
 * When presence is announced, and — mostly — when it is not (#22, P4-05).
 *
 * The cases worth writing are the ones where announcing would be a lie: a reply that was cancelled, one
 * the customer has already overtaken, one a colleague has taken over, one the business switched off. A
 * typing indicator is a promise that a reply is coming, so every one of those must be silence.
 *
 * The verdict deliberately has no list of conditions of its own — it runs the same policy evaluation the
 * delivery coordinator runs. These tests therefore move the *state* and assert the answer, rather than
 * asserting that a particular branch was taken.
 */
import { describe, expect, it } from "vitest";

import { planPresence, presenceLeadMs, presenceVerdict, type PresenceSettings } from "./presence";
import type { DeliveryChannelStatePort, DeliverySendContext } from "./ports";

const NOW = new Date("2026-10-05T12:00:00.000Z");
const WAMID = "wamid.customer-1";
const TYPING_TTL_MS = 25_000;
const MARK_READ_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const settings = (overrides: Partial<PresenceSettings> = {}): PresenceSettings => ({ mode: "READ_AND_TYPING", typingLeadMs: 8_000, ...overrides });
const both = { readReceipts: true, typingIndicator: true };

/** The one the coordinator is given; presence must answer the same way it would. */
const channel: DeliveryChannelStatePort = {
  stateFor: () => ({ window: { state: "OPEN_FREEFORM", expiresAt: new Date(NOW.getTime() + 60 * 60 * 1000) }, humanAgent: { state: "UNAVAILABLE", reason: "NOT_APPROVED" } }),
};

function context(overrides: Partial<DeliverySendContext> = {}): DeliverySendContext {
  return {
    deliveryJobId: "djob_1",
    operationId: "op_1",
    workspaceId: "ws_1",
    commercial: { paidWorkAllowed: true, aiDrafts: true, autopilot: true },
    draftId: "draft_1",
    conversationId: "conv_1",
    channel: "WHATSAPP",
    recipientExternalId: "wa-customer",
    channelAccountId: "ca_1",
    text: "We open at 10 on Saturday.",
    status: "SCHEDULED",
    attemptCount: 0,
    mode: "AUTOPILOT",
    aiEnabled: true,
    takeover: { state: "NONE" },
    replyCycle: "OWNED",
    account: "CONNECTED",
    draftNeedsReview: false,
    alreadySent: false,
    limits: { confidenceThreshold: 0.8, mandatoryReviewReasons: [], afterWindow: { channel: "WHATSAPP", policy: "SERVICE_WINDOW_ONLY" } },
    authority: { kind: "AUTOMATED" },
    guard: {} as DeliverySendContext["guard"],
    ...overrides,
  };
}

const verdict = (overrides: Partial<Parameters<typeof presenceVerdict>[1]> = {}) =>
  presenceVerdict(
    { channel, now: () => NOW },
    {
      settings: settings(),
      capabilities: both,
      context: context(),
      inboundProviderMessageId: WAMID,
      inboundOccurredAt: new Date(NOW.getTime() - 60_000),
      markReadMaxAgeMs: MARK_READ_MAX_AGE_MS,
      now: NOW,
      ...overrides,
    },
  );

describe("how far ahead of the reply the indicator may be raised", () => {
  it("never exceeds the provider's own indicator lifetime", () => {
    // Raising it earlier would display it, drop it, and leave the customer watching nothing until the
    // reply arrives — worse than never having shown it.
    expect(presenceLeadMs({ typingLeadMs: 60_000, replyDelayMs: 120_000, typingTtlMs: TYPING_TTL_MS })).toBe(TYPING_TTL_MS);
  });

  it("never exceeds the reply's own delay, so it is not scheduled before the reply was decided", () => {
    // The FAST preset's floor is 5 s, which is shorter than any sensible lead.
    expect(presenceLeadMs({ typingLeadMs: 8_000, replyDelayMs: 5_000, typingTtlMs: TYPING_TTL_MS })).toBe(5_000);
  });

  it("refuses a negative or unusable lead rather than computing one", () => {
    expect(presenceLeadMs({ typingLeadMs: -1, replyDelayMs: 30_000, typingTtlMs: TYPING_TTL_MS })).toBe(0);
    expect(presenceLeadMs({ typingLeadMs: Number.NaN, replyDelayMs: 30_000, typingTtlMs: TYPING_TTL_MS })).toBe(0);
  });
});

describe("planning an announcement when a reply is scheduled", () => {
  const plan = (overrides: Partial<Parameters<typeof planPresence>[0]> = {}) =>
    planPresence({ settings: settings(), capabilities: both, replyDelayMs: 60_000, typingTtlMs: TYPING_TTL_MS, deliverable: true, ...overrides });

  it("announces shortly before the send rather than when the delay starts", () => {
    // The whole point of the task: showing typing for the full 30-120 s delay would display it and drop
    // it, which is why the moment is computed backwards from the send.
    expect(plan()).toEqual({ kind: "ANNOUNCE", delayMs: 52_000, typing: true });
  });

  it("announces a read receipt immediately, because it is about a message that already arrived", () => {
    expect(plan({ settings: settings({ mode: "READ_ON_RECEIPT" }) })).toEqual({ kind: "ANNOUNCE", delayMs: 0, typing: false });
  });

  it("says nothing at all when the business did not ask for it", () => {
    // OFF is the default: presence is a promise to a customer, and a business opts into making it.
    expect(plan({ settings: settings({ mode: "OFF" }) })).toEqual({ kind: "NONE", reason: "MODE_OFF" });
  });

  it("falls back to a read receipt on a channel that has no typing indicator", () => {
    expect(plan({ capabilities: { readReceipts: true, typingIndicator: false } })).toEqual({ kind: "ANNOUNCE", delayMs: 0, typing: false });
  });

  it("says nothing on a channel that can carry neither", () => {
    expect(plan({ capabilities: { readReceipts: false, typingIndicator: false } })).toEqual({ kind: "NONE", reason: "CHANNEL_CANNOT" });
  });

  it("says nothing when this deployment could not send the reply it would be announcing", () => {
    // The platform's own guidance is "only display a typing indicator if you are going to respond". A
    // deployment with no transport for the channel will refuse the send when it comes due.
    expect(plan({ deliverable: false })).toEqual({ kind: "NONE", reason: "CHANNEL_CANNOT" });
  });

  it("announces at once when the reply is sooner than the lead", () => {
    expect(plan({ replyDelayMs: 3_000 })).toEqual({ kind: "ANNOUNCE", delayMs: 0, typing: true });
  });
});

describe("deciding again at the moment of announcing", () => {
  it("announces for a reply that is still going out", () => {
    expect(verdict()).toEqual({ kind: "ANNOUNCE", inboundProviderMessageId: WAMID, typing: true });
  });

  it("says nothing once the delivery is no longer scheduled", () => {
    // Cancelled, claimed, sent or held — one status covers all four, and it is the same one the claim uses.
    for (const status of ["CANCELLED_HUMAN_TAKEOVER", "CANCELLED_SUPERSEDED", "SENDING", "SENT", "HELD_REVIEW"] as const) {
      expect(verdict({ context: context({ status }) })).toEqual({ kind: "SILENT", reason: "DELIVERY_NOT_SCHEDULED" });
    }
  });

  it("says nothing once the reply has already gone out", () => {
    expect(verdict({ context: context({ alreadySent: true }) })).toEqual({ kind: "SILENT", reason: "DELIVERY_NOT_SCHEDULED" });
  });

  it("says nothing when the customer has written again since", () => {
    // The reply will be cancelled as superseded. Typing for it would be a promise this product has
    // already decided not to keep.
    expect(verdict({ context: context({ replyCycle: "SUPERSEDED" }) })).toEqual({ kind: "SILENT", reason: "SEND_NO_LONGER_APPROVED" });
  });

  it("says nothing when a person has taken the conversation over", () => {
    expect(verdict({ context: context({ takeover: { state: "HUMAN_ACTIVE", reason: "HUMAN_CLAIMED", since: NOW } }) })).toEqual({
      kind: "SILENT",
      reason: "SEND_NO_LONGER_APPROVED",
    });
  });

  it("says nothing when automation was switched off, or the thread's AI disabled", () => {
    expect(verdict({ context: context({ mode: "OFF" }) })).toEqual({ kind: "SILENT", reason: "SEND_NO_LONGER_APPROVED" });
    expect(verdict({ context: context({ aiEnabled: false }) })).toEqual({ kind: "SILENT", reason: "SEND_NO_LONGER_APPROVED" });
  });

  it("says nothing in DRAFT mode, where a person still has to approve the reply", () => {
    // The draft is held for review; nobody is typing it.
    expect(verdict({ context: context({ mode: "DRAFT" }) })).toEqual({ kind: "SILENT", reason: "SEND_NO_LONGER_APPROVED" });
  });

  it("says nothing while an operator's kill switch covers this send", () => {
    expect(verdict({ context: context({ outboundSuspended: { scope: "WORKSPACE", reason: "OPERATOR" } }) })).toEqual({
      kind: "SILENT",
      reason: "SEND_NO_LONGER_APPROVED",
    });
  });

  it("says nothing once the account is no longer connected", () => {
    expect(verdict({ context: context({ account: "NEEDS_REAUTH" }) })).toEqual({ kind: "SILENT", reason: "SEND_NO_LONGER_APPROVED" });
  });

  it("says nothing without a message the provider can identify", () => {
    expect(verdict({ inboundProviderMessageId: undefined })).toEqual({ kind: "SILENT", reason: "NO_INBOUND_MESSAGE" });
    expect(verdict({ inboundProviderMessageId: "" })).toEqual({ kind: "SILENT", reason: "NO_INBOUND_MESSAGE" });
  });

  it("says nothing about a message older than the provider still accepts", () => {
    // Only reachable after an outage long enough that announcing presence would be absurd anyway, which
    // is why it is refused here rather than discovered as a provider error.
    expect(verdict({ inboundOccurredAt: new Date(NOW.getTime() - MARK_READ_MAX_AGE_MS - 1) })).toEqual({ kind: "SILENT", reason: "INBOUND_TOO_OLD" });
  });

  it("drops the indicator but keeps the receipt when the channel stopped offering typing", () => {
    // The plan was made up to two minutes earlier; what is still true wins over what was planned.
    expect(verdict({ capabilities: { readReceipts: true, typingIndicator: false } })).toEqual({
      kind: "ANNOUNCE",
      inboundProviderMessageId: WAMID,
      typing: false,
    });
  });

  it("says nothing once the business switches presence off, even for a reply already scheduled", () => {
    expect(verdict({ settings: settings({ mode: "OFF" }) })).toEqual({ kind: "SILENT", reason: "MODE_OFF" });
  });
});
