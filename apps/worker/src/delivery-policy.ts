/**
 * The live facts a delivery decision rests on, read at send time.
 *
 * Everything here is deliberately re-read rather than carried from when the job was scheduled. The delay
 * is where a conversation changes, so an automation policy edited during it, a window that closed, or a
 * provider deadline that has since passed must all be visible to the coordinator — which is the only layer
 * allowed to act on them.
 *
 * Window evaluation uses the Instagram adapter's own rules rather than a second copy of them, but through
 * the narrow `WindowInputs` shape: answering "may a reply still be sent?" must not require the credentials
 * needed to actually send one.
 */
import type { DeliveryChannelState, PolicyLimits } from "@omnichannel/application";
import {
  evaluateHumanAgentEligibility,
  evaluateStandardWindow,
  instagramTimingPolicy,
  type WindowInputs,
} from "@omnichannel/channel-instagram";
import type { DbClient } from "@omnichannel/db";
import { isReasonCode, toQuietHours } from "@omnichannel/domain";
import type { DeliveryJob } from "@omnichannel/queue";

/** Defaults used where an account has not recorded its own; the adapter owns the verified values. */
const DEFAULT_WINDOW: Pick<WindowInputs, "standardWindowMs" | "humanAgentWindowMs"> = {
  standardWindowMs: 24 * 60 * 60 * 1000,
  humanAgentWindowMs: 7 * 24 * 60 * 60 * 1000,
};

export interface ResolvedDeliveryPolicy {
  readonly limits: PolicyLimits;
  readonly channelState: DeliveryChannelState;
}

export function createDeliveryPolicyResolver(db: DbClient, now: () => Date) {
  return async function resolve(job: DeliveryJob): Promise<ResolvedDeliveryPolicy | undefined> {
    const scope = { workspaceId: job.workspaceId, businessProfileId: job.businessProfileId };
    const conversation = await db.conversation.findUnique({
      where: { workspaceId_businessProfileId_id: { ...scope, id: job.conversationId } },
      select: {
        id: true,
        channelAccountId: true,
        lastInboundAt: true,
        channelIdentity: { select: { externalUserId: true, channelAccount: { select: { status: true } } } },
      },
    });
    if (conversation === null) {
      return undefined;
    }

    const policies = await db.automationPolicy.findMany({
      where: { ...scope, OR: [{ channelAccountId: conversation.channelAccountId }, { channelAccountId: null }] },
    });
    // A channel-account override wins over the Business Profile default, exactly as for mode resolution.
    const policy = policies.find((row) => row.channelAccountId === conversation.channelAccountId) ?? policies.find((row) => row.channelAccountId === null);
    if (policy === undefined) {
      // No policy row means the profile never opted into automation, so there is nothing to deliver.
      return undefined;
    }

    const windowInputs: WindowInputs = {
      ...DEFAULT_WINDOW,
      connectionState: conversation.channelIdentity.channelAccount.status === "CONNECTED" ? "CONNECTED" : "DISCONNECTED",
      // Approval is a live capability, not a stored boolean to be trusted; unknown fails closed.
      humanAgentApproval: "UNKNOWN",
    };
    const ctx = {
      workspaceId: job.workspaceId,
      channelAccountId: conversation.channelAccountId,
      conversationId: conversation.id,
      participantExternalId: conversation.channelIdentity.externalUserId,
      ...(conversation.lastInboundAt === null ? {} : { lastInboundAt: conversation.lastInboundAt }),
      now: now(),
    };

    const eligibility = evaluateHumanAgentEligibility(ctx, windowInputs);
    const timing = instagramTimingPolicy();
    return {
      limits: {
        confidenceThreshold: policy.confidenceThreshold,
        // Narrowed with the domain's own guard: a code the engine does not know is not a gate, and
        // treating an unrecognised string as one would block sends for a reason nobody can act on.
        mandatoryReviewReasons: policy.mandatoryReviewReasons.filter(isReasonCode),
        ...(policy.quietHoursTimeZone === null || policy.quietHoursStart === null || policy.quietHoursEnd === null
          ? {}
          : { quietHours: toQuietHours(policy.quietHoursTimeZone, policy.quietHoursStart, policy.quietHoursEnd) }),
        afterWindow: { channel: "INSTAGRAM", policy: policy.instagramAfterWindowPolicy },
      },
      channelState: {
        window: evaluateStandardWindow(ctx, windowInputs),
        humanAgent:
          eligibility.state === "ELIGIBLE"
            ? { state: "ELIGIBLE", expiresAt: eligibility.expiresAt }
            : { state: "UNAVAILABLE", reason: eligibility.state === "NOT_APPROVED" ? "NOT_APPROVED" : eligibility.state === "EXPIRED" ? "EXPIRED" : "UNKNOWN" },
        // Measured from the customer's own message, which is where the provider's clock starts.
        ...(conversation.lastInboundAt === null
          ? {}
          : { dispatchDeadline: new Date(conversation.lastInboundAt.getTime() + timing.automatedDispatchTargetMs) }),
      },
    };
  };
}
