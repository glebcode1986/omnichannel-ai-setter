import { describe, expect, it } from "vitest";

import { applyHandoffEvent, automationMayAct, type HandoffEvent } from "./handoff";
import { toUserId } from "./ids";
import type { HumanTakeoverState } from "./human-takeover";

const AT = new Date("2026-09-19T12:00:00.000Z");
const USER = { kind: "USER", userId: toUserId("01a0b40c-0000-7000-8000-000000000007") } as const;

const NONE: HumanTakeoverState = { state: "NONE" };
const REVIEW: HumanTakeoverState = { state: "REVIEW_REQUIRED", reason: "MANDATORY_REVIEW", reviewMode: "NORMAL", since: AT };
const ACTIVE = (pausedUntil?: Date): HumanTakeoverState => ({
  state: "HUMAN_ACTIVE",
  reason: "HUMAN_CLAIMED",
  since: AT,
  actor: USER,
  ...(pausedUntil === undefined ? {} : { pausedUntil }),
});

const apply = (current: HumanTakeoverState, event: HandoffEvent) => applyHandoffEvent(current, event);

describe("human activity always wins", () => {
  it("takes ownership whenever a person acts, from any state", () => {
    for (const current of [NONE, REVIEW, ACTIVE()]) {
      expect(apply(current, { kind: "HUMAN_SENT", at: AT, actor: USER })).toMatchObject({
        kind: "CHANGED",
        state: { state: "HUMAN_ACTIVE", reason: "HUMAN_SENT_FROM_INBOX" },
      });
      expect(apply(current, { kind: "CLAIMED", at: AT, actor: USER })).toMatchObject({
        kind: "CHANGED",
        state: { state: "HUMAN_ACTIVE", reason: "HUMAN_CLAIMED", actor: USER },
      });
    }
  });

  it("treats an uncorrelated outbound echo as a person using the native app", () => {
    const transition = apply(NONE, { kind: "UNMATCHED_ECHO", at: AT });

    expect(transition).toMatchObject({ kind: "CHANGED", state: { state: "HUMAN_ACTIVE", reason: "UNMATCHED_OUTBOUND_ECHO" } });
    // We cannot know which person it was, so ownership is recorded without an actor rather than guessed at.
    expect(transition.state).not.toHaveProperty("actor");
  });

  it("blocks automation in every state but NONE", () => {
    expect(automationMayAct(NONE)).toBe(true);
    expect(automationMayAct(REVIEW)).toBe(false);
    expect(automationMayAct(ACTIVE())).toBe(false);
  });
});

describe("a review request cannot demote a human", () => {
  it("leaves an active takeover untouched", () => {
    const transition = apply(ACTIVE(), { kind: "REVIEW_REQUESTED", at: AT, reason: "MANDATORY_REVIEW", reviewMode: "NORMAL" });

    // An escalation from automation is information, not a transfer of ownership.
    expect(transition).toEqual({ kind: "UNCHANGED", state: ACTIVE() });
  });

  it("does request review when nobody holds the conversation", () => {
    const transition = apply(NONE, { kind: "REVIEW_REQUESTED", at: AT, reason: "HUMAN_AGENT_REVIEW", reviewMode: "HUMAN_AGENT" });

    expect(transition).toMatchObject({
      kind: "CHANGED",
      state: { state: "REVIEW_REQUIRED", reason: "HUMAN_AGENT_REVIEW", reviewMode: "HUMAN_AGENT" },
    });
  });
});

describe("resolving a review", () => {
  it("leaves the person holding the conversation when they sent something", () => {
    const transition = apply(REVIEW, { kind: "REVIEW_RESOLVED", at: AT, actor: USER, keepOwnership: true });

    expect(transition).toMatchObject({ kind: "CHANGED", state: { state: "HUMAN_ACTIVE", actor: USER } });
  });

  it("hands the conversation back when they dismissed it", () => {
    expect(apply(REVIEW, { kind: "REVIEW_RESOLVED", at: AT, actor: USER, keepOwnership: false })).toEqual({
      kind: "CHANGED",
      state: { state: "NONE" },
    });
  });
});

describe("resume", () => {
  it("is always available to a person", () => {
    expect(apply(ACTIVE(), { kind: "RESUMED", at: AT, actor: USER })).toEqual({ kind: "CHANGED", state: { state: "NONE" } });
    expect(apply(REVIEW, { kind: "RESUMED", at: AT, actor: USER })).toEqual({ kind: "CHANGED", state: { state: "NONE" } });
  });

  it("changes nothing when automation already owns the conversation", () => {
    expect(apply(NONE, { kind: "RESUMED", at: AT, actor: USER })).toEqual({ kind: "UNCHANGED", state: NONE });
  });
});

describe("a pause elapsing is the only guarded event", () => {
  const later = new Date(AT.getTime() + 60_000);

  it("resumes automation once the configured pause has run out", () => {
    expect(apply(ACTIVE(AT), { kind: "PAUSE_ELAPSED", at: later })).toEqual({ kind: "CHANGED", state: { state: "NONE" } });
  });

  it("refuses while the pause is still running", () => {
    expect(apply(ACTIVE(new Date(later.getTime() + 1)), { kind: "PAUSE_ELAPSED", at: later })).toMatchObject({
      kind: "REFUSED",
      reason: "PAUSE_NOT_ELAPSED",
    });
  });

  it("refuses while a person is still expected to act on a review item", () => {
    // Timing out into automation here would answer a customer that a colleague was about to answer.
    expect(apply(REVIEW, { kind: "PAUSE_ELAPSED", at: later })).toMatchObject({ kind: "REFUSED", reason: "REVIEW_STILL_PENDING" });
  });

  it("never ends an open-ended takeover", () => {
    // A takeover with no configured pause is a deliberate hold; only a person can end it.
    expect(apply(ACTIVE(), { kind: "PAUSE_ELAPSED", at: later })).toMatchObject({ kind: "REFUSED", reason: "NOT_PAUSED" });
  });

  it("refuses when nobody has taken over at all", () => {
    expect(apply(NONE, { kind: "PAUSE_ELAPSED", at: later })).toMatchObject({ kind: "REFUSED", reason: "NOT_PAUSED" });
  });

  it("restarts the pause when a person acts again during it", () => {
    const paused = ACTIVE(new Date(AT.getTime() + 30_000));
    const extended = new Date(later.getTime() + 60_000);

    const after = apply(paused, { kind: "HUMAN_SENT", at: later, actor: USER, pausedUntil: extended });

    // A new manual reply extends the takeover rather than inheriting the old deadline.
    expect(after.state).toMatchObject({ state: "HUMAN_ACTIVE", pausedUntil: extended });
    expect(apply(after.state, { kind: "PAUSE_ELAPSED", at: later })).toMatchObject({ kind: "REFUSED", reason: "PAUSE_NOT_ELAPSED" });
  });
});

describe("purity", () => {
  it("never mutates the state it is given", () => {
    const current = ACTIVE(AT);
    const snapshot = JSON.stringify(current);

    applyHandoffEvent(current, { kind: "PAUSE_ELAPSED", at: new Date(AT.getTime() + 1) });
    applyHandoffEvent(current, { kind: "HUMAN_SENT", at: AT, actor: USER });

    expect(JSON.stringify(current)).toBe(snapshot);
  });
});
