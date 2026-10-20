/**
 * Whether it is worth generating a follow-up at all (#55).
 *
 * The thing to keep straight about these cases is which direction each answer is safe in. `false` declines
 * to spend an attempt and a model call; it cannot cause a send, because the policy engine still decides
 * every send twice afterwards. `true` is only "ask the engine" — so the risk being tested is a `false`
 * that silences a chase something could still have carried, and the controls below are mostly about that.
 */
import type { FollowUpChannelQuestion } from "@omnichannel/db";
import { describe, expect, it } from "vitest";

import { automatedRouteStillOpen } from "./followup-channel";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

const question = (overrides: Partial<FollowUpChannelQuestion> = {}): FollowUpChannelQuestion => ({
  channel: "INSTAGRAM",
  lastInboundAt: new Date(NOW.getTime() - 20 * HOUR),
  at: NOW,
  instagramAfterWindowPolicy: "STANDARD_ONLY",
  whatsappAfterWindowPolicy: "SERVICE_WINDOW_ONLY",
  ...overrides,
});

describe("whether any route could still carry a follow-up", () => {
  it("says yes inside the standard window, however old the message is", () => {
    // Twenty hours of silence is exactly what a follow-up is for, and it is still inside the 24-hour
    // window. This is the case the whole feature depends on.
    expect(automatedRouteStillOpen(question())).toBe(true);
    expect(automatedRouteStillOpen(question({ lastInboundAt: new Date(NOW.getTime() - HOUR) }))).toBe(true);
    // Right up to the boundary, and not past it.
    expect(automatedRouteStillOpen(question({ lastInboundAt: new Date(NOW.getTime() - 24 * HOUR + 1) }))).toBe(true);
    expect(automatedRouteStillOpen(question({ lastInboundAt: new Date(NOW.getTime() - 24 * HOUR) }))).toBe(false);
  });

  it("says no once the window has closed with no after-window route configured", () => {
    const closed = question({ lastInboundAt: new Date(NOW.getTime() - 30 * HOUR) });

    // `STANDARD_ONLY` is the conservative default and the only answer when nothing is stored. Nothing can
    // carry this message, so generating for it would spend an attempt and a model call to produce a draft
    // the policy engine then declines.
    expect(automatedRouteStillOpen(closed)).toBe(false);
  });

  it("still says yes after the window when the business opted into the human-support route", () => {
    const closed = question({ lastInboundAt: new Date(NOW.getTime() - 30 * HOUR), instagramAfterWindowPolicy: "HUMAN_ASSISTED_EXTENDED" });

    // That route produces a *review*, not a send, and offering a person the decision is the existing
    // behaviour. Answering `false` here would quietly take that decision away from them.
    expect(automatedRouteStillOpen(closed)).toBe(true);
  });

  it("says no when the customer has never written", () => {
    // Official messaging on both channels is user-initiated, so there is no conversation to follow up in
    // and no policy that could create one.
    expect(automatedRouteStillOpen(question({ lastInboundAt: null }))).toBe(false);
    expect(automatedRouteStillOpen(question({ lastInboundAt: null, instagramAfterWindowPolicy: "HUMAN_ASSISTED_EXTENDED" }))).toBe(false);
  });

  it("leaves a channel it has nothing to say about to the policy engine", () => {
    // WhatsApp's adapter is Phase 4 and its service window and template rules are not on this branch.
    // Guessing at a provider rule from here would be a second implementation of it; the engine refuses
    // what it cannot carry either way, so this only costs an attempt in a case that cannot yet arise.
    expect(automatedRouteStillOpen(question({ channel: "WHATSAPP", lastInboundAt: new Date(NOW.getTime() - 30 * HOUR) }))).toBe(true);
    expect(automatedRouteStillOpen(question({ channel: "WHATSAPP", lastInboundAt: null }))).toBe(false);
  });
});
