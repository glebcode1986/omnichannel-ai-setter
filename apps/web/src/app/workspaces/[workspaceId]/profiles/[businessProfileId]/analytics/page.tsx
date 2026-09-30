/**
 * Operational analytics (LEADS_ANALYTICS_UX.md, Issue #34).
 *
 * The page authorizes at the *workspace* and filters to this Business Profile, because that is what the
 * metric queries take: they are workspace-scoped by construction and narrowed by a filter, so a member
 * with access to one profile out of three can never be shown the other two's numbers even if the route
 * says otherwise.
 *
 * The profile id comes from the route rather than the query string, and the store intersects it with the
 * reader's grant. A hand-edited `businessProfileId` therefore returns nothing rather than somebody else's
 * figures.
 */
import { listAssignableMembers, listChannelAccounts, readOperationalSnapshot, readStageDisplays } from "@omnichannel/db";

import { FilterBar } from "@/ui/analytics/filter-bar";
import { MetricsView } from "@/ui/analytics/metrics-view";
import { requestTranslator } from "@/i18n/request-locale";
import { requireBusinessProfileContext, requireWorkspaceContext } from "@/server/request-context";
import { getDb } from "@/server/db";
import { analyticsQueryString, isFilteredView, metricFilterOf, parseAnalyticsView, windowOf, type RawSearchParams } from "@/server/analytics-view";

export default async function AnalyticsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly workspaceId: string; readonly businessProfileId: string }>;
  readonly searchParams: Promise<RawSearchParams>;
}) {
  const { workspaceId, businessProfileId } = await params;
  // Both: the profile check is what makes this URL this member's to open at all, and the workspace
  // context is what the metric queries are scoped by.
  const profileContext = await requireBusinessProfileContext(workspaceId, businessProfileId);
  const workspaceContext = await requireWorkspaceContext(workspaceId);
  const t = await requestTranslator();
  const view = parseAnalyticsView(await searchParams);
  const basePath = `/workspaces/${workspaceId}/profiles/${businessProfileId}`;
  const window = windowOf(view, new Date());

  const [snapshot, accounts, members, stages] = await Promise.all([
    readOperationalSnapshot(getDb(), workspaceContext, window, metricFilterOf(view, businessProfileId)),
    listChannelAccounts(getDb(), profileContext),
    listAssignableMembers(getDb(), profileContext),
    readStageDisplays(getDb(), profileContext),
  ]);

  const day = new Intl.DateTimeFormat("en-CA", { timeZone: view.timeZone, year: "numeric", month: "2-digit", day: "2-digit" });

  return (
    <>
      <div className="page-header">
        <h1>{t.t("analytics.title")}</h1>
        <a href={`${basePath}/settings/audit${analyticsQueryString(view)}`}>{t.t("audit.title")}</a>
      </div>

      <FilterBar
        t={t}
        view={view}
        action={`${basePath}/analytics`}
        accounts={accounts.map((account) => ({ value: account.id, label: account.displayName ?? account.externalAccountId }))}
        members={members.map((member) => ({ value: member.userId, label: member.name ?? member.userId }))}
        stages={stages.filter((stage) => !stage.hidden).map((stage) => ({ value: stage.stage, label: stage.label }))}
      />
      {isFilteredView(view) ? <a href={`${basePath}/analytics`}>{t.t("analytics.clear")}</a> : undefined}

      {/* Which days these numbers mean, in words, on every render. A dashboard that did not say would
          leave a reader comparing it with the Inbox and finding a discrepancy with no explanation. */}
      <p className="muted" data-measured-in="true">
        {t.t("analytics.measuredIn", {
          zone: view.timeZone,
          from: day.format(window.from),
          // The window's end is exclusive, so the last day it covers is the moment before it.
          to: day.format(new Date(window.to.getTime() - 1)),
        })}
      </p>

      <MetricsView t={t} snapshot={snapshot} stageLabels={Object.fromEntries(stages.map((stage) => [stage.stage, stage.label]))} />
    </>
  );
}
