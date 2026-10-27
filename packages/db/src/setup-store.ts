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
  activeSuspension,
  evaluateOnboarding,
  isOnboardingStep,
  isSkippableOnboardingStep,
  type ChannelCaveat,
  type OnboardingFacts,
  type OnboardingState,
  type OnboardingStep,
} from "@omnichannel/domain";

import { loadCoveringSuspensions } from "./suspension-covering";
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
export async function readOnboarding(db: DbClient, context: BusinessProfileContext, at = new Date()): Promise<OnboardingSnapshot> {
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
  //
  // Through the one reader, and judged by the domain. The hand-written version here selected neither
  // `since` nor `until`, so a switch that had expired on its own clock — or one scheduled to start
  // tomorrow — read as in force for ever. That is the safe direction for a send and the wrong one for a
  // screen: onboarding told a business its outbound was suspended with nothing an operator could lift.
  const suspensions = await loadCoveringSuspensions(db, { workspaceId: scope.workspaceId, businessProfileId: scope.businessProfileId });
  /**
   * Whether anything covers this account right now, asked of the domain.
   *
   * The clock rule is not re-implemented here. An empty channel-account id answers the wider question —
   * "is this profile paused however the accounts stand" — because `covers` compares the id only for the
   * `CHANNEL_ACCOUNT` scope and an empty string is no real account.
   */
  const pausedFor = (channelAccountId: string) =>
    activeSuspension(
      {
        workspaceId: scope.workspaceId,
        businessProfileId: scope.businessProfileId,
        channelAccountId,
      } as never,
      suspensions,
      at,
    ) !== undefined;

  const accountPolicy = (channelAccountId: string) =>
    policies.find((policy) => policy.channelAccountId === channelAccountId) ?? policies.find((policy) => policy.channelAccountId === null);
  const effective = policies.find((policy) => policy.channelAccountId === null) ?? policies[0];

  const facts: OnboardingFacts = {
    channels: channels.map((account) => ({
      channel: account.channel,
      status: account.status,
      canCarryText: carriesText(account.capabilities),
      mode: accountPolicy(account.id)?.mode ?? account.defaultAiMode,
      outboundSuspended: pausedFor(account.id),
      caveats: caveatsOf(account.capabilities),
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

/**
 * What this account cannot tell the product, from what was recorded when it was connected.
 *
 * Read the same checked way as `carriesText`, and for the same reason: the column is JSON written by an
 * earlier connect, so an account stored before a capability existed simply has no key for it. Reading an
 * absent key as "cannot see native replies" is the safe direction — it produces a sentence on a card,
 * where the opposite produces an assistant drafting over a colleague.
 */
function caveatsOf(capabilities: unknown): readonly ChannelCaveat[] {
  const row = typeof capabilities === "object" && capabilities !== null && !Array.isArray(capabilities) ? (capabilities as Record<string, unknown>) : {};
  return row["nativeOutboundVisible"] === true ? [] : ["NATIVE_REPLIES_INVISIBLE"];
}

/** What happened to an attempt to take a profile live. */
export type ActivationOutcome =
  | { readonly kind: "ACTIVATED" }
  /** The checklist was not clear when the write was attempted, whatever the page had shown. */
  | { readonly kind: "NOT_READY"; readonly blockers: readonly string[] }
  /** Someone else got there first, or the profile is not in setup any more. */
  | { readonly kind: "ALREADY_SETTLED" };

/**
 * Takes a Business Profile live, if it is still ready at the moment of writing.
 *
 * The readiness is re-evaluated **inside** the transaction that flips the status, against the profile row
 * locked `FOR UPDATE`. A page can sit open for an hour; a channel can be revoked or a review item can
 * arrive in that time, and a button that activated on the strength of what the page rendered would be
 * asserting something that was true earlier. This is the same reasoning the delivery claim uses, at much
 * lower stakes: read, judge and write must describe one instant.
 *
 * The guarded `updateMany` is what makes two simultaneous clicks produce one activation.
 */
export async function activateBusinessProfile(db: DbClient, context: BusinessProfileContext): Promise<ActivationOutcome> {
  requireRole(context, WORKSPACE_ADMIN_ROLES, "activating a Business Profile");
  const scope = profileScopeOf(context);

  return db.$transaction(async (tx) => {
    // Locked first, so the re-read below cannot be overtaken by another activation or by a change to the
    // profile itself between the judgement and the write. The status comes back with the lock: a profile
    // that is already live is settled, and saying "not ready" about it would be a refusal with nothing to
    // name — which is exactly what a second click used to get.
    const locked = await tx.$queryRaw<{ status: string }[]>`
      SELECT "status"::text AS status FROM "business_profiles"
      WHERE "workspace_id" = ${scope.workspaceId} AND "id" = ${scope.businessProfileId}
      FOR UPDATE`;
    if (locked.length === 0 || locked[0]?.status !== "SETUP") {
      return { kind: "ALREADY_SETTLED" };
    }

    const { state } = await readOnboarding(tx as unknown as DbClient, context);
    if (!state.canActivate) {
      return { kind: "NOT_READY", blockers: state.activationBlockers };
    }

    const activated = await tx.businessProfile.updateMany({
      // The profile's own row, so its identifier is `id` rather than the scope's `businessProfileId`.
      // Only out of SETUP: activating an INACTIVE profile is a different decision with different
      // consequences, and it is not this surface's to make.
      where: { workspaceId: scope.workspaceId, id: scope.businessProfileId, status: "SETUP" },
      data: { status: "ACTIVE" },
    });
    return activated.count === 1 ? { kind: "ACTIVATED" } : { kind: "ALREADY_SETTLED" };
  });
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
