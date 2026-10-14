/**
 * The audit log (LEADS_ANALYTICS_UX.md, Issue #34).
 *
 * Under Settings rather than as an eighth navigation section, because `PRODUCT_UX.md` already puts
 * "security/audit" there and the seven sections it names are product structure. A new top-level section
 * would be a decision about the product rather than about this task.
 *
 * Workspace-scoped, because the log is: a membership change belongs to no Business Profile, and filing it
 * under one would hide it from the only view where it makes sense. The store limits each reader to the
 * profiles they may see and to the kinds their role may read.
 */
import { readableAuditKinds, searchAuditEvents } from "@omnichannel/db";

import { AuditTable } from "@/ui/analytics/audit-table";
import { FilterBar } from "@/ui/analytics/filter-bar";
import { requestTranslator } from "@/i18n/request-locale";
import { requireBusinessProfileContext, requireWorkspaceContext } from "@/server/request-context";
import { getDb } from "@/server/db";
import { listAssignableMembers, listChannelAccounts, readStageDisplays } from "@omnichannel/db";
import { analyticsQueryString, isFilteredView, parseAnalyticsView, windowOf, type AnalyticsView, type RawSearchParams } from "@/server/analytics-view";

export default async function AuditPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly workspaceId: string; readonly businessProfileId: string }>;
  readonly searchParams: Promise<RawSearchParams>;
}) {
  const { workspaceId, businessProfileId } = await params;
  const profileContext = await requireBusinessProfileContext(workspaceId, businessProfileId);
  const workspaceContext = await requireWorkspaceContext(workspaceId);
  const t = await requestTranslator();
  const query = await searchParams;
  const view = parseAnalyticsView(query);
  const basePath = `/workspaces/${workspaceId}/profiles/${businessProfileId}`;
  const window = windowOf(view, new Date());
  const cursor = cursorOf(query);

  const [page, accounts, members, stages] = await Promise.all([
    searchAuditEvents(getDb(), workspaceContext, {
      kinds: view.kinds,
      businessProfileId,
      ...(view.channelAccountId === undefined ? {} : { channelAccountId: view.channelAccountId }),
      ...(view.term === undefined ? {} : { term: view.term }),
      from: window.from,
      to: window.to,
      ...(cursor === undefined ? {} : { cursor }),
      limit: 50,
    }),
    listChannelAccounts(getDb(), profileContext),
    listAssignableMembers(getDb(), profileContext),
    readStageDisplays(getDb(), profileContext),
  ]);

  return (
    <>
      <div className="page-header">
        <h1>{t.t("audit.title")}</h1>
        <a href={`${basePath}/analytics${analyticsQueryString(view)}`}>{t.t("analytics.title")}</a>
      </div>
      <p className="muted">{t.t("audit.lead")}</p>

      <FilterBar
        t={t}
        view={view}
        action={`${basePath}/settings/audit`}
        accounts={accounts.map((account) => ({ value: account.id, label: account.displayName ?? account.externalAccountId }))}
        members={members.map((member) => ({ value: member.userId, label: member.name ?? member.userId }))}
        stages={stages.filter((stage) => !stage.hidden).map((stage) => ({ value: stage.stage, label: stage.label }))}
        // Only the kinds this reader may see. Offering one that would return nothing would tell an Agent
        // that admin-only rows exist, which is what withholding them is for.
        kinds={readableAuditKinds(workspaceContext)}
        showSearch
      />
      {isFilteredView(view) ? <a href={`${basePath}/settings/audit`}>{t.t("analytics.clear")}</a> : undefined}

      <AuditTable
        t={t}
        rows={page.rows}
        restricted={page.restricted}
        timeZone={view.timeZone}
        {...(page.nextCursor === undefined ? {} : { olderHref: olderPage(`${basePath}/settings/audit`, view, page.nextCursor) })}
      />
    </>
  );
}

/**
 * The link to the next page, carrying the filters the reader chose.
 *
 * Built by `URLSearchParams` rather than by concatenating a query string and guessing whether it needs a
 * `?` or an `&`. The guess was the bug waiting to happen: an unfiltered view produces an empty string,
 * and the same helper was being called twice to ask what it had just returned.
 */
function olderPage(path: string, view: AnalyticsView, cursor: { readonly occurredAt: Date; readonly id: string }): string {
  const params = new URLSearchParams(analyticsQueryString(view).replace(/^\?/u, ""));
  params.set("before", `${cursor.occurredAt.toISOString()}|${cursor.id}`);
  return `${path}?${params.toString()}`;
}

/**
 * The page the reader asked for, if any.
 *
 * Defensive about its own format: a hand-edited cursor should show the first page rather than an error,
 * and an unparseable date must not become an `Invalid Date` that silently matches nothing.
 */
function cursorOf(params: RawSearchParams): { readonly occurredAt: Date; readonly id: string } | undefined {
  const raw = params["before"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === "") {
    return undefined;
  }
  const [iso, id] = value.split("|");
  if (iso === undefined || id === undefined || id === "") {
    return undefined;
  }
  const occurredAt = new Date(iso);
  return Number.isNaN(occurredAt.getTime()) ? undefined : { occurredAt, id };
}
