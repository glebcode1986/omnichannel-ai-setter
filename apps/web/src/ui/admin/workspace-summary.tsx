/**
 * The operational picture of one tenant (#59, ADMIN_OPERATIONS.md).
 *
 * Metadata only, and that is a property of the data rather than of this component: `SupportSnapshot` has
 * no field for a message body, a credential, a capability blob or a token, so there is nothing here to
 * redact and nothing a future `select` could re-leak into.
 *
 * The three things an operator actually asks first are at the top: is anything reaching this tenant, is
 * anything leaving it, and is something pausing it.
 */
import type { SupportSnapshot } from "@omnichannel/db";

import type { MessageKey } from "@/i18n/catalogue";
import type { Translator } from "@/i18n/translate";

export function WorkspaceSummary({ t, snapshot }: { readonly t: Translator; readonly snapshot: SupportSnapshot }) {
  return (
    <section className="card" data-admin="summary">
      <h2>{snapshot.name}</h2>

      <dl className="admin-summary">
        <dt>{t.t("admin.workspaceId")}</dt>
        <dd data-summary="workspace-id">{snapshot.workspaceId}</dd>

        <dt>{t.t("admin.plan")}</dt>
        <dd data-summary="plan">
          {t.t("admin.planLine", {
            plan: snapshot.entitlement.planCode,
            version: t.number(snapshot.entitlement.planVersion),
            state: t.t(`subscriptionState.${snapshot.entitlement.state}` as MessageKey),
          })}
        </dd>

        <dt>{t.t("admin.paidWork")}</dt>
        {/* The one commercial fact that decides whether the product is doing anything for this tenant. */}
        <dd data-summary="paid-work" data-allowed={snapshot.entitlement.paidWorkAllowed}>
          {snapshot.entitlement.paidWorkAllowed ? t.t("admin.paidWorkAllowed") : t.t("admin.paidWorkStopped")}
        </dd>

        <dt>{t.t("admin.lastInbound")}</dt>
        <dd data-summary="last-inbound">
          {snapshot.lastInboundAt === null ? t.t("admin.never") : t.date(snapshot.lastInboundAt, { dateStyle: "medium", timeStyle: "short" })}
        </dd>

        <dt>{t.t("admin.lastOutbound")}</dt>
        <dd data-summary="last-outbound">
          {snapshot.lastOutboundAt === null ? t.t("admin.never") : t.date(snapshot.lastOutboundAt, { dateStyle: "medium", timeStyle: "short" })}
        </dd>

        <dt>{t.t("admin.pause")}</dt>
        <dd data-summary="pause" data-paused={snapshot.pause !== undefined}>
          {snapshot.pause === undefined
            ? t.t("admin.notPaused")
            : t.t("admin.pausedLine", {
                scope: t.t(`suspensionScope.${snapshot.pause.scope}` as MessageKey),
                since: t.date(snapshot.pause.since, { dateStyle: "medium", timeStyle: "short" }),
                by: snapshot.pause.byOperator ? t.t("admin.byOperator") : t.t("admin.bySystem"),
              })}
        </dd>

        <dt>{t.t("admin.pendingReconciliations")}</dt>
        <dd data-summary="pending-reconciliations">{t.number(snapshot.pendingReconciliations)}</dd>

        <dt>{t.t("admin.usagePeriod")}</dt>
        {/* `cycleOpened` false means nobody has counted anything in this period — and reading this page
            did not open one, which is the whole reason the console has its own usage read. */}
        <dd data-summary="usage-period" data-cycle-opened={snapshot.usage.cycleOpened}>
          {t.t("admin.usagePeriodLine", {
            from: t.date(snapshot.usage.periodStartsAt, { dateStyle: "medium" }),
            to: t.date(snapshot.usage.periodEndsAt, { dateStyle: "medium" }),
          })}
        </dd>
      </dl>

      <h3>{t.t("admin.profiles")}</h3>
      <ul className="admin-profiles">
        {snapshot.profiles.map((profile) => (
          <li key={profile.businessProfileId} data-profile={profile.businessProfileId}>
            {t.t("admin.profileLine", {
              name: profile.name,
              status: t.t(`profileStatus.${profile.status}` as MessageKey),
              channels: t.number(profile.channelAccounts),
            })}
          </li>
        ))}
      </ul>

      <h3>{t.t("admin.channels")}</h3>
      {snapshot.channels.length === 0 ? (
        <p className="muted" data-channels="none">
          {t.t("admin.noChannels")}
        </p>
      ) : (
        <ul className="admin-channels">
          {snapshot.channels.map((account) => (
            <li key={account.channelAccountId} data-channel-account={account.channelAccountId}>
              {t.t("admin.channelLine", {
                channel: t.t(`channel.${account.channel}` as MessageKey),
                status: t.t(`accountStatus.${account.status}` as MessageKey),
                external: account.externalAccountId,
              })}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
