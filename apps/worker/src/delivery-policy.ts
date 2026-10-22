/**
 * The live channel facts a delivery decision rests on, derived from the state the claim will bind.
 *
 * These used to be read from the database here, before the coordinator read anything. That was a second
 * read of the same conversation and the same policy rows, a moment earlier — so the window a reply was
 * judged against and the state its claim bound could describe two different instants, and nothing in
 * between could tell. The coordinator now hands over the context it read, and everything below is derived
 * from it: one read, one judgement, one guard.
 *
 * The kill switch followed the same path, and for a sharper reason. It is an operator's decision about the
 * system rather than a fact about one conversation, so it was resolved here, outside the coordinator — but
 * a value read outside the guarded read cannot be re-asserted by the claim, and a switch committed between
 * the read and the claim was therefore invisible to the guard. `delivery-store.ts` now reads it twice,
 * once with the rest of the state and once inside the claim's own transaction (#56 / #72). Nothing here
 * resolves it, and nothing here should: a second answer to "is this send suspended" is how a switch
 * acquires a path around itself.
 *
 * Window evaluation uses the Instagram adapter's own rules rather than a second copy of them, but through
 * the narrow `WindowInputs` shape: answering "may a reply still be sent?" must not require the credentials
 * needed to actually send one. With the suspension read gone this module touches no infrastructure at all
 * — it derives, and the reading is somebody else's job.
 */
import type { DeliveryChannelState, DeliveryChannelStatePort, DeliverySendContext } from "@omnichannel/application";
import {
  evaluateHumanAgentEligibility,
  evaluateStandardWindow,
  instagramTimingPolicy,
  type HumanAgentApproval,
  type WindowInputs,
} from "@omnichannel/channel-instagram";
import { DEFAULT_SERVICE_WINDOW_MS as WHATSAPP_SERVICE_WINDOW_MS, evaluateServiceWindow } from "@omnichannel/channel-whatsapp";

/** Defaults used where an account has not recorded its own; the adapter owns the verified values. */
const DEFAULT_WINDOW: Pick<WindowInputs, "standardWindowMs" | "humanAgentWindowMs"> = {
  standardWindowMs: 24 * 60 * 60 * 1000,
  humanAgentWindowMs: 7 * 24 * 60 * 60 * 1000,
};

/**
 * The live channel facts, derived from the context the coordinator already read.
 *
 * @param humanAgentApproval whether Meta has approved *this app* for the Human Agent exception, from live
 * configuration. It is an app-level capability, not a fact about an account, so nothing stores it — and
 * hard-coding `UNKNOWN` here made the exception unreachable no matter what a person authorized, because
 * this gate runs before the transport ever gets a say. Omitted still means `UNKNOWN`, which fails closed.
 */
export function createChannelStateResolver(now: () => Date, humanAgentApproval: HumanAgentApproval = "UNKNOWN"): DeliveryChannelStatePort {
  return {
    stateFor(context: DeliverySendContext): DeliveryChannelState {
      if (context.channel === "WHATSAPP") {
        return whatsappState(context, now());
      }
      const windowInputs: WindowInputs = {
        ...DEFAULT_WINDOW,
        connectionState: context.account === "CONNECTED" ? "CONNECTED" : "DISCONNECTED",
        humanAgentApproval,
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
        // Measured from the customer's own message, which is where the provider's clock starts — and so
        // only for a send that answers one. A planned follow-up answers nothing, and a budget counted
        // from a message hours old is already spent, which would turn every follow-up into a review item
        // the moment quiet hours applied (#55).
        ...(context.lastInboundAt === undefined || context.proactive === true
          ? {}
          : { dispatchDeadline: new Date(context.lastInboundAt.getTime() + timing.automatedDispatchTargetMs) }),
      };
    },
  };
}

/**
 * WhatsApp's own rules, which differ from Instagram's in two ways that matter (#24).
 *
 * **The window has three answers, not two.** Outside the 24-hour customer-service window a conversation is
 * not closed — an approved template may still reach the customer — so `TEMPLATE_ONLY` is carried through
 * rather than collapsed into "not eligible". What to do about it is the policy engine's decision, and
 * ADR-016's three modes are how a business makes it.
 *
 * **There is no human-agent exception and no automated dispatch deadline.** Both are Instagram's: the
 * exception is a Meta approval for that platform, and the deadline comes from its rule that an automated
 * experience must answer within seconds. Applying either here would be inventing a WhatsApp rule — and the
 * deadline in particular would do visible damage, shortening or abandoning the human-like delay on every
 * WhatsApp reply for a constraint that platform does not impose.
 */
function whatsappState(context: DeliverySendContext, at: Date): DeliveryChannelState {
  return {
    window: evaluateServiceWindow(
      {
        workspaceId: context.workspaceId,
        channelAccountId: context.channelAccountId,
        conversationId: context.conversationId,
        participantExternalId: context.recipientExternalId,
        ...(context.lastInboundAt === undefined ? {} : { lastInboundAt: context.lastInboundAt }),
        now: at,
      },
      {
        connectionState: context.account === "CONNECTED" ? "CONNECTED" : "DISCONNECTED",
        serviceWindowMs: WHATSAPP_SERVICE_WINDOW_MS,
      },
    ),
    humanAgent: { state: "UNAVAILABLE", reason: "NOT_APPROVED" },
  };
}
