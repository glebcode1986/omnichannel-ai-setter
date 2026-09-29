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
import type { DeliveryChannelState, DeliveryChannelStatePort, DeliverySendContext, PolicyInput } from "@omnichannel/application";
import {
  evaluateHumanAgentEligibility,
  evaluateStandardWindow,
  instagramTimingPolicy,
  type HumanAgentApproval,
  type WindowInputs,
} from "@omnichannel/channel-instagram";
import { createSuspensionStore, type DbClient } from "@omnichannel/db";
import { activeSuspension, toBusinessProfileId, toChannelAccountId, toWorkspaceId } from "@omnichannel/domain";
import type { DeliveryJob } from "@omnichannel/queue";

/** Defaults used where an account has not recorded its own; the adapter owns the verified values. */
const DEFAULT_WINDOW: Pick<WindowInputs, "standardWindowMs" | "humanAgentWindowMs"> = {
  standardWindowMs: 24 * 60 * 60 * 1000,
  humanAgentWindowMs: 7 * 24 * 60 * 60 * 1000,
};

/**
 * Whether a kill switch covers this send.
 *
 * Deliberately not part of the state the claim binds. Every other fact a delivery rests on is something
 * *about the conversation*, read once and re-asserted as the send is taken; this one is an operator's
 * decision about the system, and it is read for the run rather than for the conversation. It is still
 * read here, with everything else the decision rests on, so the switch is honoured by the same gate that
 * honours every other rule — a separate check closer to the wire is how a switch acquires a path around
 * it.
 */
export function createSuspensionResolver(db: DbClient, now: () => Date) {
  const suspensions = createSuspensionStore(db);

  return async function resolve(job: DeliveryJob): Promise<PolicyInput["outboundSuspended"] | undefined> {
    const scope = { workspaceId: job.workspaceId, businessProfileId: job.businessProfileId };
    const conversation = await db.conversation.findUnique({
      where: { workspaceId_businessProfileId_id: { ...scope, id: job.conversationId } },
      select: { channelAccountId: true },
    });
    if (conversation === null) {
      return undefined;
    }

    // The identifiers go through the domain's own constructors rather than a cast: these three decide
    // which switches cover this send, and a blank or swapped one would silently widen or narrow that
    // answer. A cast would make the type-checker agree to exactly the mistake worth catching.
    const target = {
      workspaceId: toWorkspaceId(scope.workspaceId),
      businessProfileId: toBusinessProfileId(scope.businessProfileId),
      channelAccountId: toChannelAccountId(conversation.channelAccountId),
    };
    const covering = await suspensions.loadCovering({ ...scope, channelAccountId: conversation.channelAccountId });
    const suspended = activeSuspension(target, covering, now());
    return suspended === undefined ? undefined : { scope: suspended.scope, reason: suspended.reason };
  };
}

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
        // Measured from the customer's own message, which is where the provider's clock starts.
        ...(context.lastInboundAt === undefined
          ? {}
          : { dispatchDeadline: new Date(context.lastInboundAt.getTime() + timing.automatedDispatchTargetMs) }),
      };
    },
  };
}
