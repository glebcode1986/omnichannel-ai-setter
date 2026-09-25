/**
 * The live channel facts a delivery decision rests on, derived from the state the claim will bind.
 *
 * These used to be read from the database here, before the coordinator read anything. That was a second
 * read of the same conversation and the same policy rows, a moment earlier — so the window a reply was
 * judged against and the state its claim bound could describe two different instants, and nothing in
 * between could tell. The coordinator now hands over the context it read, and everything below is derived
 * from it: one read, one judgement, one guard.
 *
 * Window evaluation uses the Instagram adapter's own rules rather than a second copy of them, but through
 * the narrow `WindowInputs` shape: answering "may a reply still be sent?" must not require the credentials
 * needed to actually send one.
 */
import type { DeliveryChannelState, DeliveryChannelStatePort, DeliverySendContext } from "@omnichannel/application";
import {
  evaluateHumanAgentEligibility,
  evaluateStandardWindow,
  instagramTimingPolicy,
  type WindowInputs,
} from "@omnichannel/channel-instagram";

/** Defaults used where an account has not recorded its own; the adapter owns the verified values. */
const DEFAULT_WINDOW: Pick<WindowInputs, "standardWindowMs" | "humanAgentWindowMs"> = {
  standardWindowMs: 24 * 60 * 60 * 1000,
  humanAgentWindowMs: 7 * 24 * 60 * 60 * 1000,
};

export function createChannelStateResolver(now: () => Date): DeliveryChannelStatePort {
  return {
    stateFor(context: DeliverySendContext): DeliveryChannelState {
      const windowInputs: WindowInputs = {
        ...DEFAULT_WINDOW,
        connectionState: context.account === "CONNECTED" ? "CONNECTED" : "DISCONNECTED",
        // Approval is a live capability, not a stored boolean to be trusted; unknown fails closed.
        humanAgentApproval: "UNKNOWN",
      };
      const ctx = {
        workspaceId: context.workspaceId,
        channelAccountId: context.channelAccountId,
        conversationId: context.conversationId,
        participantExternalId: context.recipientExternalId,
        ...(context.lastInboundAt === undefined ? {} : { lastInboundAt: context.lastInboundAt }),
        now: now(),
      };

      const eligibility = evaluateHumanAgentEligibility(ctx, windowInputs);
      const timing = instagramTimingPolicy();
      return {
        window: evaluateStandardWindow(ctx, windowInputs),
        humanAgent:
          eligibility.state === "ELIGIBLE"
            ? { state: "ELIGIBLE", expiresAt: eligibility.expiresAt }
            : { state: "UNAVAILABLE", reason: eligibility.state === "NOT_APPROVED" ? "NOT_APPROVED" : eligibility.state === "EXPIRED" ? "EXPIRED" : "UNKNOWN" },
        // Measured from the customer's own message, which is where the provider's clock starts.
        ...(context.lastInboundAt === undefined
          ? {}
          : { dispatchDeadline: new Date(context.lastInboundAt.getTime() + timing.automatedDispatchTargetMs) }),
      };
    },
  };
}
