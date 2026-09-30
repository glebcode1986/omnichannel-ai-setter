/**
 * Reading what onboarding has actually produced, and recording what a person chose to skip (Issue #27).
 *
 * The reads here are deliberately shallow counts and existence checks rather than whole entities. What the
 * setup surface needs to know is "has this been done", and loading knowledge documents to answer it would
 * be loading customer data to render a tick.
 *
 * Every query is scoped by the caller's authorized Business Profile context. `profileScopeOf` is the only
 * source of the scope, so a caller cannot pass a profile it was not authorized for.
 */
import {
  evaluateOnboarding,
  isOnboardingStep,
  isSkippableOnboardingStep,
  type OnboardingFacts,
  type OnboardingState,
  type OnboardingStep,
} from "@omnichannel/domain";

import { profileScopeOf, requireRole, WORKSPACE_ADMIN_ROLES, type BusinessProfileContext } from "./tenancy";
import type { DbClient } from "./client";
import { DbInputError } from "./errors";

export interface OnboardingSnapshot {
  readonly facts: OnboardingFacts;
  readonly skipped: readonly OnboardingStep[];
  readonly state: OnboardingState;
}

/**
 * Everything the setup surface renders, read in one pass.
 *
 * The facts and the skips are read together and evaluated together: a page that read them separately could
 * show a checklist built from two different instants, which is the same class of mistake the delivery
 * claim exists to prevent — smaller stakes here, same reasoning.
 */
export async function readOnboarding(db: DbClient, context: BusinessProfileContext): Promise<OnboardingSnapshot> {
  const scope = profileScopeOf(context);

  const [profile, channels, policies, knowledgeDocumentCount, styleProfileCount, styleExampleCount, blockingReviewItemCount, skips] =
    await Promise.all([
      db.businessProfile.findUniqueOrThrow({
        where: { workspaceId_id: { workspaceId: scope.workspaceId, id: scope.businessProfileId } },
        select: { status: true },
      }),
      db.channelAccount.findMany({
        where: scope,
        select: { channel: true, status: true, capabilities: true, defaultAiMode: true, id: true },
        orderBy: { createdAt: "asc" },
      }),
      db.automationPolicy.findMany({
        where: scope,
        select: {
          channelAccountId: true,
          mode: true,
          quietHoursTimeZone: true,
          instagramAfterWindowPolicy: true,
        },
      }),
      db.knowledgeDocument.count({ where: scope }),
      db.styleProfile.count({ where: scope }),
      db.styleExample.count({ where: { ...scope, approvedByUserId: { not: null } } }),
      // A review item nobody has resolved: the conversation is waiting for a person. Launching on top of
      // these would start the business's automated life by ignoring its own queue.
      db.conversation.count({ where: { ...scope, takeoverState: "REVIEW_REQUIRED" } }),
      db.onboardingSkip.findMany({ where: scope, select: { step: true } }),
    ]);

  // A kill switch covering the whole workspace or profile is what separates "eligible" from "would send
  // right now", so it is read here rather than assumed absent (Issue #56).
  const suspensions = await db.automationSuspension.findMany({
    where: {
      liftedAt: null,
      OR: [
        { scope: "GLOBAL" },
        { scope: "WORKSPACE", workspaceId: scope.workspaceId },
        { scope: "BUSINESS_PROFILE", workspaceId: scope.workspaceId, businessProfileId: scope.businessProfileId },
        { scope: "CHANNEL_ACCOUNT", workspaceId: scope.workspaceId },
      ],
    },
    select: { scope: true, channelAccountId: true },
  });
  const profileWideSuspension = suspensions.some((row) => row.scope !== "CHANNEL_ACCOUNT");
  const suspendedAccounts = new Set(suspensions.filter((row) => row.scope === "CHANNEL_ACCOUNT").map((row) => row.channelAccountId));

  const accountPolicy = (channelAccountId: string) =>
    policies.find((policy) => policy.channelAccountId === channelAccountId) ?? policies.find((policy) => policy.channelAccountId === null);
  const effective = policies.find((policy) => policy.channelAccountId === null) ?? policies[0];

  const facts: OnboardingFacts = {
    channels: channels.map((account) => ({
      channel: account.channel,
      status: account.status,
      canCarryText: carriesText(account.capabilities),
      mode: accountPolicy(account.id)?.mode ?? account.defaultAiMode,
      outboundSuspended: profileWideSuspension || suspendedAccounts.has(account.id),
    })),
    policyConfigured: policies.length > 0,
    // Quiet hours are the only timing field with no default, so they are the only one whose presence
    // proves a business actually made a timing choice. Everything else it could "choose" is already the
    // recommended preset, which is why the step is skippable rather than pretending to detect intent.
    timingConfigured: effective?.quietHoursTimeZone !== null && effective?.quietHoursTimeZone !== undefined,
    // Instagram is the only channel with an outside-window choice today; a profile with no Instagram
    // account has nothing to choose, and the step is complete rather than permanently pending.
    channelPolicyConfigured:
      !channels.some((account) => account.channel === "INSTAGRAM") ||
      (effective !== undefined && effective.instagramAfterWindowPolicy !== undefined),
    knowledgeDocumentCount,
    styleConfigured: styleProfileCount > 0 || styleExampleCount > 0,
    // The no-send simulation is P5-04's surface; until it exists a profile can only reach this step by
    // skipping it, which is exactly what the step being skippable is for.
    testDriveCompleted: false,
    blockingReviewItemCount,
    activated: profile.status === "ACTIVE",
  };

  const skipped = skips.map((row) => row.step).filter((step): step is OnboardingStep => isOnboardingStep(step));
  return { facts, skipped, state: evaluateOnboarding(facts, skipped) };
}

/**
 * Records that a person decided to pass over an optional step.
 *
 * Refused for a step that is not optional, in the store as well as in the domain and in a CHECK
 * constraint. Three places sounds like two too many until you notice each covers a different writer: the
 * domain covers a decision made from stale data, this covers a caller, and the constraint covers everyone
 * including a hand-written `INSERT` during a support call.
 */
export async function skipOnboardingStep(
  db: DbClient,
  context: BusinessProfileContext,
  step: string,
): Promise<void> {
  requireRole(context, WORKSPACE_ADMIN_ROLES, "skipping a setup step");
  if (!isOnboardingStep(step) || !isSkippableOnboardingStep(step)) {
    throw new DbInputError("step", "must be a setup step that may be skipped");
  }
  const scope = profileScopeOf(context);
  await db.onboardingSkip.upsert({
    where: { workspaceId_businessProfileId_step: { ...scope, step } },
    // Skipping twice is the same decision, so the first one keeps its author and its timestamp.
    update: {},
    create: { ...scope, step, skippedByUserId: context.userId },
  });
}

/**
 * Whether a stored capability record says this channel can carry text.
 *
 * A checked read rather than a cast. The column is JSON, so its shape is a runtime question, and the one
 * field the readiness ladder needs is worth asking for honestly.
 */
function carriesText(capabilities: unknown): boolean {
  if (typeof capabilities !== "object" || capabilities === null || Array.isArray(capabilities)) {
    return false;
  }
  return (capabilities as Record<string, unknown>).text === true;
}

/** Undoes a skip, so a person who changes their mind sees the step again. */
export async function unskipOnboardingStep(db: DbClient, context: BusinessProfileContext, step: string): Promise<void> {
  requireRole(context, WORKSPACE_ADMIN_ROLES, "restoring a setup step");
  if (!isOnboardingStep(step)) {
    throw new DbInputError("step", "must be a setup step");
  }
  const scope = profileScopeOf(context);
  await db.onboardingSkip.deleteMany({ where: { ...scope, step } });
}
