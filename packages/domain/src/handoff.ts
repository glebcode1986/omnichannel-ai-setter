/**
 * Who owns a conversation, and what may change that (HUMAN_HANDOFF.md, ADR-004, ADR-013).
 *
 * The rule the whole file serves: **human activity always wins over automation.** Everything else is a
 * consequence of stating that precisely enough to be executable.
 *
 * Two consequences worth naming, because both are places where a plausible-looking shortcut goes wrong:
 *
 * - **ownership is not mode.** OFF/DRAFT/AUTOPILOT is what the business configured; takeover is who is
 *   holding the conversation right now. Folding them together would mean resuming automation had to guess
 *   which of the two a value meant.
 * - **a request for review cannot demote a human.** If someone is already handling the conversation, an
 *   escalation from automation is information, not a transfer of ownership: it must not quietly move the
 *   conversation out of their hands.
 *
 * The transition function is pure and total. Every event either produces a state or is refused with a
 * reason, and a refusal is a normal answer rather than an exception — callers act on it.
 */
import { literalGuard } from "./enum";
import type { Actor, HumanTakeoverState, ReviewMode, TakeoverReason } from "./human-takeover";

export const HANDOFF_EVENT_KINDS = [
  /** A person sent a reply from our own inbox. */
  "HUMAN_SENT",
  /** An outbound message we cannot correlate to one of our sends: someone used the native app (ADR-013). */
  "UNMATCHED_ECHO",
  /** A person explicitly took the conversation. */
  "CLAIMED",
  /** Automation needs a decision before anything goes out. */
  "REVIEW_REQUESTED",
  /** A human finished with the review item. */
  "REVIEW_RESOLVED",
  /** A person handed the conversation back to automation. */
  "RESUMED",
  /** A configured pause elapsed; automation may resume only if the guards still hold. */
  "PAUSE_ELAPSED",
] as const;
export type HandoffEventKind = (typeof HANDOFF_EVENT_KINDS)[number];
export const isHandoffEventKind = literalGuard(HANDOFF_EVENT_KINDS);

export type HandoffEvent =
  | { readonly kind: "HUMAN_SENT"; readonly at: Date; readonly actor?: Actor; readonly pausedUntil?: Date }
  | { readonly kind: "UNMATCHED_ECHO"; readonly at: Date; readonly pausedUntil?: Date }
  | { readonly kind: "CLAIMED"; readonly at: Date; readonly actor: Actor; readonly pausedUntil?: Date }
  | { readonly kind: "REVIEW_REQUESTED"; readonly at: Date; readonly reason: TakeoverReason; readonly reviewMode: ReviewMode }
  | { readonly kind: "REVIEW_RESOLVED"; readonly at: Date; readonly actor: Actor; readonly keepOwnership: boolean }
  | { readonly kind: "RESUMED"; readonly at: Date; readonly actor: Actor }
  | { readonly kind: "PAUSE_ELAPSED"; readonly at: Date };

export type HandoffTransition =
  | { readonly kind: "CHANGED"; readonly state: HumanTakeoverState }
  /** The event was valid but changes nothing; the caller should not write a new audit row for it. */
  | { readonly kind: "UNCHANGED"; readonly state: HumanTakeoverState }
  | { readonly kind: "REFUSED"; readonly state: HumanTakeoverState; readonly reason: HandoffRefusal };

export const HANDOFF_REFUSALS = [
  /** A pause cannot elapse while a person is still expected to act on a review item. */
  "REVIEW_STILL_PENDING",
  /** The configured pause has not run out yet. */
  "PAUSE_NOT_ELAPSED",
  /** Automation cannot resume itself; only a person, or an elapsed pause with its guards satisfied, can. */
  "NOT_PAUSED",
] as const;
export type HandoffRefusal = (typeof HANDOFF_REFUSALS)[number];

/**
 * Applies one event to the current ownership state.
 *
 * `PAUSE_ELAPSED` is the only event with guards, and deliberately so: it is the only one not driven by a
 * person. Everything a human does is taken at face value, because second-guessing an operator is how a
 * system ends up racing the person it is supposed to be helping.
 */
export function applyHandoffEvent(current: HumanTakeoverState, event: HandoffEvent): HandoffTransition {
  switch (event.kind) {
    case "HUMAN_SENT":
      return changed(humanActive("HUMAN_SENT_FROM_INBOX", event.at, event.actor, event.pausedUntil));
    case "UNMATCHED_ECHO":
      // Sent from the native app. We cannot know which person it was, so ownership is recorded without an
      // actor rather than attributed to a guess.
      return changed(humanActive("UNMATCHED_OUTBOUND_ECHO", event.at, undefined, event.pausedUntil));
    case "CLAIMED":
      return changed(humanActive("HUMAN_CLAIMED", event.at, event.actor, event.pausedUntil));

    case "REVIEW_REQUESTED":
      if (current.state === "HUMAN_ACTIVE") {
        // Someone is already holding it. An escalation is information, not a transfer of ownership.
        return { kind: "UNCHANGED", state: current };
      }
      return changed({ state: "REVIEW_REQUIRED", reason: event.reason, reviewMode: event.reviewMode, since: event.at });

    case "REVIEW_RESOLVED":
      // Resolving by sending leaves the person holding the conversation; dismissing hands it back.
      return changed(event.keepOwnership ? humanActive("HUMAN_SENT_FROM_INBOX", event.at, event.actor) : { state: "NONE" });

    case "RESUMED":
      return current.state === "NONE" ? { kind: "UNCHANGED", state: current } : changed({ state: "NONE" });

    case "PAUSE_ELAPSED": {
      if (current.state === "REVIEW_REQUIRED") {
        return refused(current, "REVIEW_STILL_PENDING");
      }
      if (current.state !== "HUMAN_ACTIVE") {
        return refused(current, "NOT_PAUSED");
      }
      if (current.pausedUntil === undefined) {
        // An open-ended takeover never times out. Only a person can end it.
        return refused(current, "NOT_PAUSED");
      }
      return current.pausedUntil.getTime() > event.at.getTime()
        ? refused(current, "PAUSE_NOT_ELAPSED")
        : changed({ state: "NONE" });
    }
  }
}

/** Automation may act only when nobody holds the conversation and nothing is waiting on a person. */
export function automationMayAct(state: HumanTakeoverState): boolean {
  return state.state === "NONE";
}

function humanActive(reason: TakeoverReason, since: Date, actor?: Actor, pausedUntil?: Date): HumanTakeoverState {
  return {
    state: "HUMAN_ACTIVE",
    reason,
    since,
    ...(actor === undefined ? {} : { actor }),
    ...(pausedUntil === undefined ? {} : { pausedUntil }),
  };
}

const changed = (state: HumanTakeoverState): HandoffTransition => ({ kind: "CHANGED", state });
const refused = (state: HumanTakeoverState, reason: HandoffRefusal): HandoffTransition => ({ kind: "REFUSED", state, reason });
