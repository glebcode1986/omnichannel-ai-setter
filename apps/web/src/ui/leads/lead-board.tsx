/**
 * The lead pipeline, as a board and as a table (LEADS_ANALYTICS_UX.md, Issue #33).
 *
 * Both views render from the same rows. A kanban and a table that disagreed about which leads exist would
 * be two answers to one question, and the table is the board's accessible fallback rather than a
 * different feature — so it is always present, and the board is what a wide screen adds.
 *
 * **Moving a lead is a form, not a drag.** Every card carries the stage it was rendered in, and the move
 * posts that alongside the destination: the server refuses a move from a stage the lead has already left.
 * A drag-and-drop layer can be added on top of exactly this submission later; what it must not do is
 * become a second path that skips the check. The contract asks for one audited transition API, and this
 * is a caller of it rather than an alternative to it.
 *
 * **A suggestion is never a move.** The assistant's reading is shown on the card with its own control, so
 * agreeing with it is a deliberate act that the history records as `HUMAN_CONFIRMED` rather than as the
 * assistant having moved anything.
 */
import Link from "next/link";
import type { LeadRow, StageDisplay } from "@omnichannel/db";

import type { MessageKey } from "@/i18n/catalogue";
import type { Translator } from "@/i18n/translate";
import { stageName, stageNameOf } from "@/ui/leads/stage-name";
import type { LeadTarget } from "@/server/lead-actions";

export interface LeadBoardProps {
  readonly t: Translator;
  readonly leads: readonly LeadRow[];
  readonly stages: readonly StageDisplay[];
  readonly target: LeadTarget;
  readonly basePath: string;
  readonly filtered: boolean;
  readonly moveAction: (target: LeadTarget, formData: FormData) => Promise<void>;
}

export function LeadBoard({ t, leads, stages, target, basePath, filtered, moveAction }: LeadBoardProps) {
  if (leads.length === 0) {
    return (
      <p className="muted" data-empty="true">
        {filtered ? t.t("leads.emptyFiltered") : t.t("leads.empty")}
      </p>
    );
  }

  // Hidden columns are not drawn, but their leads are not lost: the table below lists every lead
  // whatever stage it is in, which is why hiding a column is safe.
  const visible = stages.filter((stage) => !stage.hidden);
  // Both names come from `stage-name.ts`, which every surface that shows a stage now shares: the board,
  // the panel, the column editor and the leads page's own filter. See that module for why.
  const nameOfStage = (stage: StageDisplay) => stageName(t, stage);
  const labelOf = (stage: string) => stageNameOf(t, stages, stage);

  return (
    <>
      <div className="lead-board" aria-label={t.t("leads.boardLabel")}>
        {visible.map((stage) => {
          const inStage = leads.filter((lead) => lead.stage === stage.stage);
          return (
            <section key={stage.stage} className="lead-column" data-stage={stage.stage}>
              <h3>{t.t("leads.stageColumn", { label: nameOfStage(stage), count: inStage.length })}</h3>
              <ul>
                {inStage.map((lead) => (
                  <li key={lead.conversationId} data-lead={lead.conversationId}>
                    <Link href={`${basePath}/inbox/${lead.conversationId}`}>{lead.contactName ?? lead.handle}</Link>
                    <Link className="muted" href={`${basePath}/leads?lead=${lead.conversationId}`} data-open-lead="true">
                      {t.t("leads.assignee")}, {t.t("leads.tags")}, {t.t("leads.history")}
                    </Link>
                    <p className="muted">
                      {t.t(`channel.${lead.channel}` as MessageKey)} ·{" "}
                      {lead.assignedUserName ?? t.t("leads.unassigned")}
                    </p>
                    {lead.tags.length === 0 ? undefined : (
                      <span className="conversation-badges">
                        {lead.tags.map((tag) => (
                          <span key={tag} className="badge" data-tone="muted" data-tag={tag}>
                            {tag}
                          </span>
                        ))}
                      </span>
                    )}
                    {lead.nextAction === null ? undefined : (
                      <p className="muted" data-next-action="true">
                        {lead.nextAction}
                        {lead.nextActionAt === null ? "" : ` · ${t.date(lead.nextActionAt, { dateStyle: "short" })}`}
                      </p>
                    )}

                    {/* The assistant's reading, with its own control. Agreeing is a deliberate act the
                        history records as a person's confirmation, not as the assistant moving anything. */}
                    {lead.suggestedStage === null || lead.suggestedStage === lead.stage ? undefined : (
                      <form action={moveAction.bind(null, target)} data-suggestion={lead.suggestedStage}>
                        <input type="hidden" name="conversationId" value={lead.conversationId} />
                        <input type="hidden" name="expectedStage" value={lead.stage} />
                        <input type="hidden" name="toStage" value={lead.suggestedStage} />
                        <input type="hidden" name="suggestedStage" value={lead.suggestedStage} />
                        <p className="muted">{t.t("leads.suggested", { label: labelOf(lead.suggestedStage) })}</p>
                        <p className="muted">{t.t("leads.suggestedHint")}</p>
                        <button className="button" type="submit" data-action="confirm-suggestion">
                          {t.t("leads.confirmSuggestion")}
                        </button>
                      </form>
                    )}

                    {/* The move. Carries the stage this card was drawn in, which is what makes a stale
                        board safe: the server refuses a move from a stage the lead has already left. */}
                    <form action={moveAction.bind(null, target)} className="lead-move">
                      <input type="hidden" name="conversationId" value={lead.conversationId} />
                      <input type="hidden" name="expectedStage" value={lead.stage} />
                      <label htmlFor={`move-${lead.conversationId}`}>{t.t("leads.moveTo")}</label>
                      <select id={`move-${lead.conversationId}`} name="toStage" defaultValue={lead.stage}>
                        {stages.map((candidate) => (
                          <option key={candidate.stage} value={candidate.stage}>
                            {nameOfStage(candidate)}
                          </option>
                        ))}
                      </select>
                      <button className="button" type="submit" data-action="move">
                        {t.t("leads.move")}
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>

      {/* Always present: the board's accessible fallback, and the only view that lists a lead sitting in
          a hidden stage. */}
      {/*
        The roles repeat what the elements already mean, and they are not redundant: below 900px the
        stylesheet gives these elements `display: block` to lay each lead out as a card, and a browser
        derives a table element's implicit role from its computed display. Without the roles written out,
        the table stops being a table for assistive technology at exactly the widths where it is the only
        view of a lead — the row header stops identifying its row, and the cells stop having columns.
      */}
      <table className="lead-table" role="table">
        <caption>{t.t("leads.tableLabel")}</caption>
        <thead role="rowgroup">
          <tr role="row">
            <th scope="col" role="columnheader">
              {t.t("leads.tableHeadContact")}
            </th>
            <th scope="col" role="columnheader">
              {t.t("leads.tableHeadStage")}
            </th>
            <th scope="col" role="columnheader">
              {t.t("leads.tableHeadOwner")}
            </th>
            <th scope="col" role="columnheader">
              {t.t("leads.tableHeadNext")}
            </th>
            <th scope="col" role="columnheader">
              {t.t("leads.tableHeadUpdated")}
            </th>
          </tr>
        </thead>
        <tbody role="rowgroup">
          {leads.map((lead) => (
            <tr key={lead.conversationId} data-row={lead.conversationId} role="row">
              <th scope="row" role="rowheader">
                <Link href={`${basePath}/inbox/${lead.conversationId}`}>{lead.contactName ?? lead.handle}</Link>
              </th>
              <td data-label={t.t("leads.tableHeadStage")} data-stage={lead.stage} role="cell">
                {labelOf(lead.stage)}
              </td>
              <td data-label={t.t("leads.tableHeadOwner")} role="cell">{lead.assignedUserName ?? t.t("leads.unassigned")}</td>
              <td data-label={t.t("leads.tableHeadNext")} role="cell">{lead.nextAction ?? ""}</td>
              <td data-label={t.t("leads.tableHeadUpdated")} role="cell">
                <time dateTime={lead.lastMessageAt.toISOString()}>{t.date(lead.lastMessageAt, { dateStyle: "short", timeStyle: "short" })}</time>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
