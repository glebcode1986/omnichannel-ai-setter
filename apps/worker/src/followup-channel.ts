/**
 * Whether anything at all could carry a follow-up right now (#55).
 *
 * `claimFollowUp` asks this inside its own transaction, with the facts it read under the conversation
 * lock, because a messaging window is read from a timestamp another transaction may be writing. The
 * provider knowledge lives here, in the composition root's layer, so `packages/db` keeps importing no
 * channel adapter.
 *
 * **This can never permit a send.** The policy engine decides every send twice downstream — at the
 * disposition and again at the final pre-send gate — so the only thing answering `false` does is decline
 * to spend an attempt and a model call on a follow-up nothing could have delivered. The asymmetry matters:
 * a wrong `false` silences a chase that would have become a review item, a wrong `true` wastes one of
 * three attempts and changes nothing a customer sees. So this answers `false` only where there is
 * provably no route, and leaves everything else to the engine.
 */
import { DEFAULT_STANDARD_WINDOW_MS } from "@omnichannel/channel-instagram";
import type { FollowUpChannelQuestion } from "@omnichannel/db";

export function automatedRouteStillOpen(question: FollowUpChannelQuestion): boolean {
  if (question.lastInboundAt === null) {
    // Official messaging on both channels is user-initiated. With no inbound message there is no
    // conversation to follow up in, and no policy can create one.
    return false;
  }
  if (question.channel !== "INSTAGRAM") {
    // Nothing to say yet. WhatsApp's adapter is Phase 4 and its service window and template rules are not
    // on this branch; the policy engine already refuses what it cannot carry, so this leaves the decision
    // there rather than guessing at a provider rule from here.
    return true;
  }
  // The window length comes from the adapter, which owns the verified provider value. The eligibility
  // *decision* for an actual send is still `evaluateStandardWindow`'s at both real gates; this is only
  // "is it worth generating", and it reads the same constant so the two cannot drift apart.
  const open = question.lastInboundAt.getTime() + DEFAULT_STANDARD_WINDOW_MS > question.at.getTime();
  // Inside the standard window a follow-up is an ordinary automated send. Outside it, the only remaining
  // route is the human-support exception — which produces a review rather than a send, and that is the
  // existing behaviour and a person's decision to make. With `STANDARD_ONLY` there is no route at all.
  return open || question.instagramAfterWindowPolicy === "HUMAN_ASSISTED_EXTENDED";
}
