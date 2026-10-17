/**
 * What happens to a draft the moment it exists (#16).
 *
 * This is the seam between generation and delivery, and the only decision it makes is to ask someone else.
 * It builds the live policy input, calls the shared policy engine, and does what the engine says: schedule
 * a durable delayed delivery, ask for a human, or nothing at all.
 *
 * It deliberately contains no rule of its own. Every branch below is a translation of a decision made
 * elsewhere — which is the point of the architecture guard in the P2-09 contract: there is one policy
 * engine and one delivery coordinator, and no path around either.
 */
import {
  evaluatePolicy,
  planPresence,
  selectDeliveryDelayMs,
  type PolicyDecision,
  type PolicyInput,
  type PresenceSettings,
} from "@omnichannel/application";
import {
  DEFAULT_HUMAN_AGENT_WINDOW_MS,
  DEFAULT_STANDARD_WINDOW_MS,
  evaluateHumanAgentEligibility,
  instagramTimingPolicy,
  remainingAutomatedDispatchMs,
  type HumanAgentApproval,
} from "@omnichannel/channel-instagram";
import { presenceCapabilitiesOf, presenceSettingsOf, requestHumanReview, scheduleAutomatedDelivery, type DbClient } from "@omnichannel/db";
import { isReasonCode, NO_CAPABILITIES, toQuietHours, type ChannelAccountStatus } from "@omnichannel/domain";
import type { Logger } from "@omnichannel/observability";
import type { QueueProducer } from "@omnichannel/queue";

export interface DraftDispositionDependencies {
  readonly db: DbClient;
  readonly producer: QueueProducer;
  readonly logger: Logger;
  readonly now: () => Date;
  readonly random: () => number;
  /**
   * Whether Meta has approved this app for the Human Agent exception, from live configuration.
   *
   * The same answer the final gate uses, from the same place, because the two decide the same question at
   * different moments: whether a person *could* be offered the human-support path, and whether they may
   * still take it. Hard-coded `UNAVAILABLE` here, a draft outside the window was skipped outright — no
   * review item was ever created, so the path nobody could reach was also a path nobody was offered.
   * Omitted means `UNKNOWN`, which fails closed.
   */
  readonly humanAgentApproval?: HumanAgentApproval;
  /**
   * What this deployment can signal to a customer while a reply is being written (#22).
   *
   * Absent means no presence is scheduled at all, which is what a deployment with no announcer should do:
   * a job that always declines is work nobody benefits from. Presence is never scheduled for a draft that
   * was held or skipped, because those paths return before this is reached.
   */
  readonly presence?: PresenceScheduling;
}

export interface PresenceScheduling {
  /**
   * How long a typing indicator survives at the provider. A platform fact, passed in because the
   * application layer that bounds the lead by it cannot import a channel adapter.
   */
  readonly typingTtlMs: number;
  /**
   * The channels this deployment can actually deliver a reply on.
   *
   * Not a capability of the channel and not a business setting: a deployment with no transport configured
   * for a channel refuses the send when it comes due, and announcing that someone is typing a reply which
   * will never be sent is precisely the experience the platform asks implementers to avoid. One value,
   * read once from the composition that builds the sender, so the two cannot disagree.
   */
  readonly deliverableChannels: ReadonlySet<string>;
}

export interface DraftDispositionInput {
  readonly workspaceId: string;
  readonly businessProfileId: string;
  readonly conversationId: string;
  readonly draftId: string;
  readonly correlationId: string;
}

export type DraftDisposition =
  | { readonly status: "SCHEDULED"; readonly operationId: string; readonly delayMs: number }
  | { readonly status: "REVIEW"; readonly reasons: readonly string[] }
  | { readonly status: "SKIPPED"; readonly reasons: readonly string[] }
  /** The provider's budget was already spent before a delay could be chosen; a person decides. */
  | { readonly status: "DEADLINE_MISSED" };

/**
 * Whether a human could still reply under the provider's human-support exception.
 *
 * Computed from the customer's own last message — the provider's clock — and the app's live approval, with
 * the adapter's own rules rather than a second copy of them. Anything unknown fails closed: a review item
 * offering a path that does not exist is worse than no review item at all.
 */
function humanAgentAvailability(
  dependencies: DraftDispositionDependencies,
  where: { readonly workspaceId: string; readonly conversationId: string },
  conversation: {
    channelAccountId: string;
    lastInboundAt: Date | null;
    channelIdentity: { externalUserId: string; channelAccount: { status: ChannelAccountStatus } };
  },
  now: Date,
): PolicyInput["humanAgent"] {
  const eligibility = evaluateHumanAgentEligibility(
    {
      workspaceId: where.workspaceId,
      channelAccountId: conversation.channelAccountId,
      conversationId: where.conversationId,
      participantExternalId: conversation.channelIdentity.externalUserId,
      ...(conversation.lastInboundAt === null ? {} : { lastInboundAt: conversation.lastInboundAt }),
      now,
    },
    {
      standardWindowMs: DEFAULT_STANDARD_WINDOW_MS,
      humanAgentWindowMs: DEFAULT_HUMAN_AGENT_WINDOW_MS,
      // The account's live state, not an assumption: one that needs re-auth cannot carry a human-support
      // reply either, and offering the path in review would send a person down a route that fails.
      connectionState: conversation.channelIdentity.channelAccount.status === "CONNECTED" ? "CONNECTED" : "DISCONNECTED",
      humanAgentApproval: dependencies.humanAgentApproval ?? "UNKNOWN",
    },
  );
  if (eligibility.state === "ELIGIBLE") {
    return { state: "ELIGIBLE", expiresAt: eligibility.expiresAt };
  }
  return { state: "UNAVAILABLE", reason: eligibility.state === "NOT_APPROVED" ? "NOT_APPROVED" : eligibility.state === "EXPIRED" ? "EXPIRED" : "UNKNOWN" };
}

export function createDraftDisposition(dependencies: DraftDispositionDependencies) {
  return async function disposeOfDraft(input: DraftDispositionInput): Promise<DraftDisposition> {
    const now = dependencies.now();
    const scope = { workspaceId: input.workspaceId, businessProfileId: input.businessProfileId };

    const draft = await dependencies.db.aiDraft.findUnique({
      where: { workspaceId_businessProfileId_id: { ...scope, id: input.draftId } },
      // `trigger` because a follow-up attempt answers no message of the customer's, and the provider's
      // automated-response budget below is counted from the message being answered (#55).
      select: { text: true, confidence: true, reasonCodes: true, factualSourceIds: true, needsReview: true, status: true, retrieval: true, trigger: true },
    });
    const conversation = await dependencies.db.conversation.findUnique({
      where: { workspaceId_businessProfileId_id: { ...scope, id: input.conversationId } },
      select: {
        channelAccountId: true,
        lastInboundAt: true,
        aiEnabled: true,
        status: true,
        takeoverState: true,
        modeOverride: true,
        channelIdentity: { select: { externalUserId: true, channelAccount: { select: { status: true, channel: true, capabilities: true } } } },
      },
    });
    if (draft === null || conversation === null) {
      return { status: "SKIPPED", reasons: ["the draft or conversation no longer exists"] };
    }

    const policies = await dependencies.db.automationPolicy.findMany({
      where: { ...scope, OR: [{ channelAccountId: conversation.channelAccountId }, { channelAccountId: null }] },
    });
    const policy = policies.find((row) => row.channelAccountId === conversation.channelAccountId) ?? policies.find((row) => row.channelAccountId === null);
    if (policy === undefined) {
      // No policy row means this profile never opted into automation at all.
      return { status: "SKIPPED", reasons: ["no automation policy"] };
    }

    // The provider timing rules the budget below is measured against. Named for Instagram because they
    // are Instagram's; `remainingMs` states when they apply and when they do not.
    const timing = instagramTimingPolicy();
    /**
     * How long the provider's automated-response budget still allows, or `undefined` when it does not
     * apply. Two independent reasons it may not, and both have already cost this product a working
     * feature, so both are kept.
     *
     * **It is Instagram's budget, and only Instagram's.** WhatsApp publishes no such deadline, so
     * measuring one against a WhatsApp send would shorten or abandon the human-like delay for a rule that
     * platform does not impose.
     *
     * **It does not apply to a planned follow-up, on any channel.** The budget is Meta's rule about
     * answering a person promptly and it starts at *their* message; a follow-up exists precisely because
     * they stopped writing, so its anchor is hours or days old by design and a budget measured from it is
     * always already spent. Applying it anyway sent every follow-up to `DEADLINE_MISSED`, which asked a
     * person to review a message nobody is waiting for and left the attempt to be cancelled as
     * `REVIEW_PENDING` — so the feature could be wired up correctly end to end and still never send
     * anything.
     *
     * Nothing else is relaxed: the 24-hour messaging window is still computed from the customer's last
     * message and still refuses a follow-up outside it, and every other gate is untouched.
     */
    const remainingMs =
      conversation.lastInboundAt === null ||
      conversation.channelIdentity.channelAccount.channel !== "INSTAGRAM" ||
      draft.trigger === "FOLLOW_UP"
        ? undefined
        : remainingAutomatedDispatchMs(conversation.lastInboundAt, now, timing);
    const decision: PolicyDecision = evaluatePolicy({
      mode: conversation.modeOverride ?? policy.mode,
      aiEnabled: conversation.aiEnabled && conversation.status === "OPEN",
      takeover:
        conversation.takeoverState === "HUMAN_ACTIVE"
          ? { state: "HUMAN_ACTIVE", reason: "HUMAN_CLAIMED", since: now }
          : conversation.takeoverState === "REVIEW_REQUIRED"
            ? { state: "REVIEW_REQUIRED", reason: "MANDATORY_REVIEW", reviewMode: "NORMAL", since: now }
            : { state: "NONE" },
      draft: {
        usable: draft.text !== null && draft.status !== "HELD",
        confidence: draft.confidence,
        reasonCodes: draft.reasonCodes.filter(isReasonCode),
        citedSourceIds: draft.factualSourceIds,
        contentType: "TEXT",
      },
      retrieval: {
        suppliedSourceIds: suppliedIdsOf(draft.retrieval),
        corpusReachable: (draft.retrieval as { status?: string } | null)?.status !== "UNAVAILABLE",
      },
      limits: {
        confidenceThreshold: policy.confidenceThreshold,
        mandatoryReviewReasons: policy.mandatoryReviewReasons.filter(isReasonCode),
        ...(policy.quietHoursTimeZone === null || policy.quietHoursStart === null || policy.quietHoursEnd === null
          ? {}
          : { quietHours: toQuietHours(policy.quietHoursTimeZone, policy.quietHoursStart, policy.quietHoursEnd) }),
        // The channel's own policy, not Instagram's for everything. Naming one channel here meant a
        // WhatsApp conversation was judged by Instagram's after-window rules — which have different
        // values and a different meaning — and ADR-016's three WhatsApp modes could never take effect.
        afterWindow:
          conversation.channelIdentity.channelAccount.channel === "WHATSAPP"
            ? { channel: "WHATSAPP", policy: policy.whatsappAfterWindowPolicy }
            : { channel: "INSTAGRAM", policy: policy.instagramAfterWindowPolicy },
      },
      account: conversation.channelIdentity.channelAccount.status,
      capabilities: { ...NO_CAPABILITIES, text: true },
      window: windowFor(conversation.channelIdentity.channelAccount.channel, conversation.lastInboundAt, now),
      // Approval is a live capability, and eligibility is computed from the customer's own last message —
      // the provider's clock — rather than assumed. Without an approved app it stays unavailable.
      humanAgent: humanAgentAvailability(dependencies, { workspaceId: input.workspaceId, conversationId: input.conversationId }, conversation, now),
      ...(remainingMs === undefined ? {} : { dispatchDeadline: new Date(now.getTime() + remainingMs) }),
      replyCycle: "OWNED",
      now,
    });

    const fields = { correlationId: input.correlationId, conversationId: input.conversationId, draftId: input.draftId };

    if (decision.action === "SKIP") {
      dependencies.logger.info("worker.draft_skipped", { ...fields, reasons: decision.reasons });
      return { status: "SKIPPED", reasons: decision.reasons };
    }
    if (decision.action === "HOLD_REVIEW") {
      await requestHumanReview(dependencies.db, { ...scope, conversationId: input.conversationId, reviewMode: decision.reviewMode, at: now });
      dependencies.logger.info("worker.draft_held_for_review", { ...fields, reasons: decision.reasons, reviewMode: decision.reviewMode });
      return { status: "REVIEW", reasons: decision.reasons };
    }

    // A human-like delay, shortened to whatever the provider still allows, or abandoned if nothing is left.
    const delay = selectDeliveryDelayMs({
      range: { minMs: policy.deliveryDelayMinMs, maxMs: policy.deliveryDelayMaxMs },
      random: dependencies.random,
      ...(remainingMs === undefined ? {} : { remainingBudgetMs: remainingMs }),
    });
    if (delay.kind === "DEADLINE_MISSED") {
      await requestHumanReview(dependencies.db, { ...scope, conversationId: input.conversationId, reviewMode: "NORMAL", at: now });
      dependencies.logger.warn("worker.draft_deadline_missed", fields);
      return { status: "DEADLINE_MISSED" };
    }

    const scheduled = await scheduleAutomatedDelivery(dependencies.db, {
      ...scope,
      draftId: input.draftId,
      correlationId: input.correlationId,
      delayMs: delay.delayMs,
      now,
    });
    // Persisted first, enqueued second: a queue that loses the job still leaves a record of what was meant
    // to happen and when.
    await dependencies.producer.scheduleDelivery({
      schemaVersion: 1,
      ...scope,
      correlationId: input.correlationId,
      conversationId: input.conversationId,
      draftId: input.draftId,
      deliveryJobId: scheduled.operationId,
      operationId: scheduled.operationId,
      scheduledFor: scheduled.scheduledFor.toISOString(),
      selectedDelayMs: delay.delayMs,
    });
    dependencies.logger.info("worker.draft_scheduled", { ...fields, operationId: scheduled.operationId, delayMs: delay.delayMs, shortened: delay.shortened });

    // After the reply is scheduled and never before it: presence announces that a reply is coming, so it
    // may only exist once one actually is. A held or skipped draft returned above and never reaches here.
    await announcePresenceLater(dependencies, {
      ...scope,
      correlationId: input.correlationId,
      conversationId: input.conversationId,
      channelAccountId: conversation.channelAccountId,
      channel: conversation.channelIdentity.channelAccount.channel,
      capabilities: conversation.channelIdentity.channelAccount.capabilities,
      settings: presenceSettingsOf(policy),
      operationId: scheduled.operationId,
      replyDelayMs: delay.delayMs,
      fields,
    });
    return { status: "SCHEDULED", operationId: scheduled.operationId, delayMs: delay.delayMs };
  };
}

/**
 * The messaging window as this decision needs it.
 *
 * Both channels open a 24-hour window from the customer's own last message. They differ at the end of it:
 * an Instagram conversation with no inbound has never been eligible, while a WhatsApp one is
 * `TEMPLATE_ONLY` — an approved template is the documented way to start a conversation there, and calling
 * it "not eligible" would throw away the only business-initiated route the platform has.
 */
function windowFor(channel: string, lastInboundAt: Date | null, now: Date): PolicyInput["window"] {
  if (channel === "WHATSAPP") {
    if (lastInboundAt === null) {
      return { state: "TEMPLATE_ONLY" };
    }
    const expiresAt = new Date(lastInboundAt.getTime() + 24 * 60 * 60 * 1000);
    return expiresAt.getTime() > now.getTime() ? { state: "OPEN_FREEFORM", expiresAt } : { state: "TEMPLATE_ONLY" };
  }
  return lastInboundAt === null
    ? { state: "NOT_ELIGIBLE", reason: "no user-initiated conversation" }
    : { state: "OPEN_FREEFORM", expiresAt: new Date(lastInboundAt.getTime() + 24 * 60 * 60 * 1000) };
}

/**
 * Queues the presence announcement for a reply that was just scheduled.
 *
 * Deliberately after the delivery is both persisted and enqueued, and deliberately unable to affect
 * either: a failure here is logged and swallowed, because a cosmetic signal must never cost a customer
 * their reply. The delay engine's own choice is read, never changed — presence fits inside the reply's
 * delay and has no say in it.
 */
async function announcePresenceLater(
  dependencies: DraftDispositionDependencies,
  input: {
    readonly workspaceId: string;
    readonly businessProfileId: string;
    readonly correlationId: string;
    readonly conversationId: string;
    readonly channelAccountId: string;
    readonly channel: string;
    readonly capabilities: unknown;
    readonly settings: PresenceSettings;
    readonly operationId: string;
    readonly replyDelayMs: number;
    readonly fields: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  const presence = dependencies.presence;
  if (presence === undefined) {
    return;
  }
  const plan = planPresence({
    settings: input.settings,
    capabilities: presenceCapabilitiesOf(input.capabilities),
    replyDelayMs: input.replyDelayMs,
    typingTtlMs: presence.typingTtlMs,
    deliverable: presence.deliverableChannels.has(input.channel),
  });
  if (plan.kind === "NONE") {
    dependencies.logger.debug("worker.presence_not_scheduled", { ...input.fields, reason: plan.reason });
    return;
  }
  try {
    await dependencies.producer.schedulePresence(
      {
        schemaVersion: 1,
        workspaceId: input.workspaceId,
        businessProfileId: input.businessProfileId,
        correlationId: input.correlationId,
        channelAccountId: input.channelAccountId,
        conversationId: input.conversationId,
        operationId: input.operationId,
        typing: plan.typing,
      },
      { delayMs: plan.delayMs },
    );
    dependencies.logger.info("worker.presence_scheduled", { ...input.fields, operationId: input.operationId, delayMs: plan.delayMs, typing: plan.typing });
  } catch (error) {
    // The reply is already scheduled and durable. Losing a typing indicator to a queue hiccup is the
    // cheapest possible failure, and it must stay that cheap.
    dependencies.logger.warn("worker.presence_not_scheduled", {
      ...input.fields,
      reason: "ENQUEUE_FAILED",
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}

/** The supplied chunk IDs recorded with the draft; an unreadable record supplies nothing. */
function suppliedIdsOf(retrieval: unknown): readonly string[] {
  const knowledge = (retrieval as { knowledge?: unknown } | null)?.knowledge;
  if (!Array.isArray(knowledge)) {
    return [];
  }
  return knowledge.map((entry) => (entry as { chunkId?: unknown }).chunkId).filter((id): id is string => typeof id === "string");
}
