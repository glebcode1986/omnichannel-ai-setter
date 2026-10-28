/**
 * What this Workspace actually is, as far as the product can honestly tell (#115).
 *
 * The page it replaces listed profile names and a status badge. That was true and useless to somebody who
 * has just created a workspace: the two questions at that moment are "is anything connected" and "has my
 * trial started", and neither was answered anywhere before the billing screen, which is three clicks past
 * the point of asking.
 *
 * Every sentence here corresponds to a state the server read. In particular there is no sentence for "a
 * trial is running" that can be produced by anything other than a `TRIALING` subscription, and no
 * sentence promising a trial on connection in a deployment that has published no trial plan — those two
 * are the ways a screen tells somebody something false about their own account, and they are separate
 * branches for that reason rather than one `else`.
 */
import Link from "next/link";

import type { MessageKey } from "@/i18n/catalogue";
import type { Translator } from "@/i18n/translate";
import type { WorkspaceOnboardingState } from "@omnichannel/db";

export interface WorkspaceEntryProps {
  readonly t: Translator;
  readonly workspaceId: string;
  readonly state: WorkspaceOnboardingState;
}

/** The one line about money and time, which is the question a new workspace is actually asking. */
function TrialLine({ t, state }: { readonly t: Translator; readonly state: WorkspaceOnboardingState }) {
  const { trial } = state;
  if (trial.noTrialReason === "TRIAL_PLAN_UNPUBLISHED") {
    // A configuration fault, not a step the customer can take: `ensureWorkspaceTrial` returns silently
    // when no trial version is published, so a connection would succeed and grant nothing. Marked as a
    // blocker because somebody has to act, and it is not the person reading it.
    return (
      <p className="notice" role="status" data-trial="TRIAL_PLAN_UNPUBLISHED" data-tone="stop">
        {t.t("onboarding.trialUnavailable")}
      </p>
    );
  }
  if (trial.noTrialReason === "AWAITING_FIRST_CONNECTION") {
    return (
      <p className="notice" role="status" data-trial="AWAITING_FIRST_CONNECTION">
        {t.t("onboarding.trialNotStarted")}
      </p>
    );
  }
  if (trial.subscriptionState === undefined) {
    return undefined;
  }
  return (
    <p className="notice" role="status" data-trial={trial.subscriptionState}>
      {t.t("onboarding.subscriptionState", { state: t.t(`subscriptionState.${trial.subscriptionState}` as MessageKey) })}
      {trial.trialEndsAt === undefined ? undefined : (
        <>
          {" "}
          <time dateTime={trial.trialEndsAt.toISOString()}>
            {t.t("billing.trialEnds", { when: t.date(trial.trialEndsAt, { dateStyle: "medium" }) })}
          </time>
        </>
      )}
    </p>
  );
}

export function WorkspaceEntry({ t, workspaceId, state }: WorkspaceEntryProps) {
  return (
    <>
      <TrialLine t={t} state={state} />
      {state.profiles.length === 0 ? <p>{t.t("workspaces.profilesEmpty")}</p> : undefined}
      <ul className="card-grid" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {state.profiles.map((profile) => (
          <li className="card" key={profile.businessProfileId} data-profile={profile.businessProfileId}>
            <h2 style={{ margin: "0 0 4px", fontSize: "1.1rem" }}>
              <Link href={`/workspaces/${workspaceId}/profiles/${profile.businessProfileId}`}>{profile.name}</Link>
            </h2>
            <p>
              <span className="badge" data-tone={profile.status === "ACTIVE" ? "ok" : "warn"}>
                {t.t(`profileStatus.${profile.status}` as MessageKey)}
              </span>
            </p>
            <p className="muted" data-channels={profile.connectedChannels.join(",")}>
              {profile.connectedChannels.length === 0
                ? t.t("onboarding.noChannelConnected")
                : t.t("onboarding.channelsConnected", {
                    channels: profile.connectedChannels.map((channel) => t.t(`channel.${channel}` as MessageKey)).join(", "),
                  })}
            </p>
            <p>
              <Link href={`/workspaces/${workspaceId}/profiles/${profile.businessProfileId}/setup`}>{t.t("onboarding.continueSetup")}</Link>
            </p>
          </li>
        ))}
      </ul>
    </>
  );
}
