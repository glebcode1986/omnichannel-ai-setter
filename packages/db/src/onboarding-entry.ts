/**
 * What the front door must be able to say out loud (#115).
 *
 * The product had no path by which a customer created the Workspace and Business Profile it is built
 * around: `createWorkspaceWithOwner` and `createBusinessProfile` existed and only tests called them. The
 * pages that now offer that creation have to report the state it produces, and the hard part is reporting
 * it *honestly* — a chooser that says "trial active" because a subscription row exists, or says nothing
 * at all about a deployment that cannot start a trial, teaches a person something false about their own
 * account.
 *
 * Read in one pass at one instant, for the reason `billing-overview.ts` gives: a page assembled from
 * several independent reads can show a profile from one moment beside a trial state from another, and the
 * sentence it builds out of them was true at neither.
 *
 * Three things are deliberately *not* here:
 *
 * - **no provider identifiers and no credentials.** Which channels are live is a product fact; the
 *   external account id, the display name a provider supplied and the credential reference are not needed
 *   to say "Instagram is connected", and a value that reaches a page can reach a view-source.
 * - **no decision.** Nothing here says what the person should do next. `onboardingChecklist` already owns
 *   that for a profile, and a second opinion computed here would be free to disagree with the checklist
 *   the same person sees one click later.
 * - **no writes.** Reading the front door must not start a trial, create a policy or touch a
 *   subscription. The trial starts on a verified channel connection, in `connectChannelAccount`, and
 *   nowhere else.
 */
import type { BusinessProfileId, BusinessProfileStatus, ChannelType, SubscriptionState } from "@omnichannel/domain";

import { findTrialPlanVersion } from "./accepted-catalog";
import type { DbClient } from "./client";
import { listAuthorizedBusinessProfiles } from "./repositories/workspaces";
import { scopeOf, type WorkspaceContext } from "./tenancy";

/** One Business Profile as the entry page shows it: what it is called, how far it got, what it speaks on. */
export interface OnboardingProfileState {
  readonly businessProfileId: BusinessProfileId;
  readonly name: string;
  readonly status: BusinessProfileStatus;
  /**
   * Channels with a live account, in a stable order. A disconnected account is history and is absent:
   * "Instagram is connected" must mean a connection exists now, which is also exactly what decides
   * whether connecting again would start the trial.
   */
  readonly connectedChannels: readonly ChannelType[];
}

/** Why no trial is running, when none is. The two reasons need different sentences and different actions. */
export type NoTrialReason =
  /** Nothing is connected yet. The trial starts on the first verified connection, so this is "not yet". */
  | "AWAITING_FIRST_CONNECTION"
  /**
   * This deployment has published no trial plan version, so a successful connection would start nothing.
   * A configuration fault rather than a step the customer can take, and the one state that must never be
   * rendered as a trial: `ensureWorkspaceTrial` returns silently in this case, by design — a catalogue
   * that was never published must not fail a customer's channel connection — which means a screen is the
   * only place the fact can surface at all.
   */
  | "TRIAL_PLAN_UNPUBLISHED";

export interface OnboardingTrialState {
  /** The normalized state of the workspace's subscription, absent where it has never had one. */
  readonly subscriptionState?: SubscriptionState;
  /** The plan behind that subscription, absent for the same reason. Never a provider's own identifier. */
  readonly planCode?: string;
  /** When a running trial ends. Present only for a subscription that actually is a trial. */
  readonly trialEndsAt?: Date;
  /** Set only when no subscription exists at all, and then it says which of the two reasons applies. */
  readonly noTrialReason?: NoTrialReason;
}

export interface WorkspaceOnboardingState {
  readonly profiles: readonly OnboardingProfileState[];
  readonly trial: OnboardingTrialState;
  /** The instant every fact above was read at, so a page can say when it last knew. */
  readonly readAt: Date;
}

/** A deterministic order, so two reads of the same state render the same sentence. */
const CHANNEL_ORDER: readonly ChannelType[] = ["INSTAGRAM", "WHATSAPP"];

/**
 * The entry state for one Workspace, scoped to what this membership may see.
 *
 * Profiles come from `listAuthorizedBusinessProfiles`, so a SELECTED-scope member sees their grants and
 * not the workspace's whole list — the channel query below is then bounded by *those* ids rather than by
 * the workspace, which keeps the two answers consistent with each other. Deriving the channel rows from
 * the workspace alone would have leaked the existence of profiles the caller may not see.
 */
export async function readWorkspaceOnboarding(
  db: DbClient,
  context: WorkspaceContext,
  at = new Date(),
): Promise<WorkspaceOnboardingState> {
  const workspaceId = scopeOf(context);
  const profiles = await listAuthorizedBusinessProfiles(db, context);
  const profileIds = profiles.map((profile) => profile.businessProfileId as string);

  const [accounts, subscription, trialPlan] = await Promise.all([
    profileIds.length === 0
      ? Promise.resolve([])
      : db.channelAccount.findMany({
          where: { workspaceId, businessProfileId: { in: profileIds }, status: { not: "DISCONNECTED" } },
          select: { businessProfileId: true, channel: true },
        }),
    db.workspaceSubscription.findUnique({
      where: { workspaceId },
      select: { state: true, trialEndsAt: true, planVersion: { select: { plan: { select: { code: true } } } } },
    }),
    findTrialPlanVersion(db),
  ]);

  const live = new Map<string, Set<ChannelType>>();
  for (const account of accounts) {
    const channels = live.get(account.businessProfileId) ?? new Set<ChannelType>();
    channels.add(account.channel);
    live.set(account.businessProfileId, channels);
  }

  return {
    profiles: profiles.map((profile) => ({
      businessProfileId: profile.businessProfileId,
      name: profile.name,
      status: profile.status,
      connectedChannels: CHANNEL_ORDER.filter((channel) => live.get(profile.businessProfileId)?.has(channel) === true),
    })),
    trial:
      subscription === null
        ? {
            // The order of these two matters. An unpublished trial plan is the stronger fact: a person
            // who connects a channel will get no trial, and telling them "connect to start your trial"
            // would be a promise this deployment cannot keep.
            noTrialReason: trialPlan === null ? "TRIAL_PLAN_UNPUBLISHED" : "AWAITING_FIRST_CONNECTION",
          }
        : {
            subscriptionState: subscription.state,
            planCode: subscription.planVersion.plan.code,
            // Only for a subscription that is a trial. A paid term also carries an end date, and
            // presenting that as a trial expiry is how a screen tells a paying customer their trial is
            // about to run out.
            ...(subscription.state === "TRIALING" && subscription.trialEndsAt !== null
              ? { trialEndsAt: subscription.trialEndsAt }
              : {}),
          },
    readAt: at,
  };
}
