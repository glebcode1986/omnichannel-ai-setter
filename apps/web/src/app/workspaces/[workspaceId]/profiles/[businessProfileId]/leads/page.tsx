/**
 * The Leads workspace (LEADS_ANALYTICS_UX.md, Issue #33).
 *
 * Conversation-linked CRM-lite: a lead *is* a conversation, which is why every card links into the Inbox
 * and why the stage a person confirms is the conversation's own. The assistant's suggestion lives beside
 * it and never replaces it.
 */
import { listAssignableMembers, listLeads, readQualification, readStageDisplays, readStageHistory, type LeadFilter } from "@omnichannel/db";
import { isLeadStage } from "@omnichannel/domain";

import { LeadBoard } from "@/ui/leads/lead-board";
import { LeadPanel } from "@/ui/leads/lead-panel";
import { StageConfig } from "@/ui/leads/stage-config";
import { OutcomeNotice } from "@/ui/outcome-notice";
import { requestTranslator } from "@/i18n/request-locale";
import { requireBusinessProfileContext } from "@/server/request-context";
import { getDb } from "@/server/db";
import { editLeadAction, moveLeadAction, recordAnswerAction, saveStagesAction } from "@/server/lead-actions";
import type { RawSearchParams } from "@/server/inbox-view";

function one(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first === "" ? undefined : first;
}

export default async function LeadsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly workspaceId: string; readonly businessProfileId: string }>;
  readonly searchParams: Promise<RawSearchParams>;
}) {
  const { workspaceId, businessProfileId } = await params;
  const context = await requireBusinessProfileContext(workspaceId, businessProfileId);
  const t = await requestTranslator();
  const query = await searchParams;
  const target = { workspaceId, businessProfileId };
  const basePath = `/workspaces/${workspaceId}/profiles/${businessProfileId}`;
  const leadsPath = `${basePath}/leads`;

  const stage = one(query["stage"]);
  const owner = one(query["owner"]);
  const tag = one(query["tag"]);
  const search = one(query["q"]);
  const filter: LeadFilter = {
    // Validated against the domain's own list: a stage nobody defined is dropped rather than queried.
    ...(isLeadStage(stage) ? { stage } : {}),
    ...(owner === undefined ? {} : { assignedUserId: owner }),
    ...(tag === undefined ? {} : { tag }),
    ...(search === undefined ? {} : { search }),
  };

  const [stages, leads, members] = await Promise.all([
    readStageDisplays(getDb(), context),
    listLeads(getDb(), context, filter),
    listAssignableMembers(getDb(), context),
  ]);

  // The lead a person opened, if any. In the URL rather than in state so a reload and a shared link both
  // land on the same lead — the same reason the Inbox keeps its selection there.
  const openedId = one(query["lead"]);
  const opened = openedId === undefined ? undefined : leads.find((lead) => lead.conversationId === openedId);
  const [history, qualification] =
    opened === undefined
      ? [[], []]
      : await Promise.all([readStageHistory(getDb(), context, opened.conversationId), readQualification(getDb(), context, opened.conversationId)]);

  return (
    <>
      <div className="page-header">
        <h1>{t.t("leads.title")}</h1>
      </div>

      <OutcomeNotice t={t} outcome={one(query["outcome"])} />

      <form action={leadsPath} method="get" role="search" className="inbox-search">
        <label htmlFor="leads-q">{t.t("inbox.searchLabel")}</label>
        <input id="leads-q" name="q" type="search" defaultValue={search ?? ""} />

        <label htmlFor="leads-stage">{t.t("leads.tableHeadStage")}</label>
        <select id="leads-stage" name="stage" defaultValue={filter.stage ?? ""}>
          <option value="">{t.t("inbox.filterAll")}</option>
          {stages.map((display) => (
            <option key={display.stage} value={display.stage}>
              {display.label}
            </option>
          ))}
        </select>

        <label htmlFor="leads-tag">{t.t("leads.tags")}</label>
        <input id="leads-tag" name="tag" type="text" defaultValue={tag ?? ""} />

        <button className="button" type="submit">
          {t.t("inbox.applyFilters")}
        </button>
      </form>

      <StageConfig t={t} stages={stages} target={target} action={saveStagesAction} />

      <LeadBoard
        t={t}
        leads={leads}
        stages={stages}
        target={target}
        basePath={basePath}
        filtered={Object.keys(filter).length > 0}
        moveAction={moveLeadAction}
      />

      {opened === undefined ? undefined : (
        <LeadPanel
          t={t}
          lead={opened}
          stages={stages}
          members={members}
          history={history}
          qualification={qualification}
          target={target}
          editAction={editLeadAction}
          answerAction={recordAnswerAction}
        />
      )}
    </>
  );
}
