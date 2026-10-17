/**
 * The policy question a scheduled send is judged by, built from one read (#16, and #22 for presence).
 *
 * Extracted from the coordinator so that everything which asks "may this reply still go out?" asks it the
 * same way. Presence is the second caller: announcing that we are typing is a promise that a reply is
 * coming, so it must rest on the same judgement the send itself will rest on rather than on a second,
 * shorter list of conditions that drifts away from it.
 *
 * It is a pure function of the context, the channel facts derived from that same context, and one instant.
 * Nothing here reads anything.
 */
import type { PolicyInput } from "../policy/inputs";

import type { DeliveryChannelStatePort, DeliverySendContext } from "./ports";

export function policyInputFor(
  dependencies: { readonly channel: DeliveryChannelStatePort; readonly now: () => Date },
  context: DeliverySendContext,
): PolicyInput {
  // Both from the read the claim will bind: the limits the store returned with the state, and the channel
  // facts derived from that same state. Nothing here was read at a different moment from anything else.
  const channelState = dependencies.channel.stateFor(context);
  return {
    mode: context.mode,
    aiEnabled: context.aiEnabled,
    takeover: context.takeover,
    draft: {
      // The draft is already written and validated; what matters now is whether it may still go out.
      usable: context.text !== undefined,
      // Confidence and categories were judged when the draft was approved. Re-judging them here would
      // re-litigate a decision, not revalidate a state, so this gate carries the approval forward and lets
      // the *state* gates do the work.
      confidence: context.draftNeedsReview ? 0 : 1,
      reasonCodes: [],
      citedSourceIds: [],
      contentType: "TEXT",
    },
    retrieval: { suppliedSourceIds: [], corpusReachable: true },
    limits: context.limits,
    account: context.account,
    capabilities: { text: true, image: false, video: false, audio: false, document: false, interactive: false, templates: false, reactions: false, readReceipts: false, typingIndicator: false },
    window: channelState.window,
    humanAgent: channelState.humanAgent,
    ...(channelState.dispatchDeadline === undefined ? {} : { dispatchDeadline: channelState.dispatchDeadline }),
    // From the context, so the switch the decision honours is the one the claim re-asserts. It is still
    // an operator's decision about the system rather than a fact about this conversation — but a value
    // read outside the guarded read cannot be bound by the claim, and unbound is how it was bypassable.
    ...(context.outboundSuspended === undefined ? {} : { outboundSuspended: context.outboundSuspended }),
    replyCycle: context.replyCycle,
    authority: context.authority,
    now: dependencies.now(),
  };
}
