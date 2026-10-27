/**
 * One lead: its fields, its stage history and what we know about it (LEADS_ANALYTICS_UX.md, Issue #33).
 *
 * Used on the Leads page and again inside the Inbox, from one component, because "edit a lead from the
 * conversation" and "edit a lead from the board" have to be the same edit. Two forms would be two sets of
 * defaults and eventually two behaviours.
 *
 * **The stage is absent from this form on purpose.** Everything here is an ordinary field a person owns;
 * a stage change is an audited transition that carries the stage the operator was looking at, and putting
 * it in a form full of unrelated inputs would make a stale save into a silent stage overwrite.
 *
 * **Qualification answers are listed by source, never merged.** The assistant's reading and a person's
 * confirmation are different claims about the same question, and a reader who saw one field could not
 * tell whether anybody had ever looked at it.
 */
import type { AssignableMember, LeadRow, QualificationAnswer, StageDisplay, StageHistoryEntry } from "@omnichannel/db";

import type { MessageKey } from "@/i18n/catalogue";
import type { Translator } from "@/i18n/translate";
import { stageName, stageNameOf } from "@/ui/leads/stage-name";
import type { LeadTarget } from "@/server/lead-actions";

export interface LeadPanelProps {
  readonly t: Translator;
  readonly lead: LeadRow;
  readonly stages: readonly StageDisplay[];
  readonly members: readonly AssignableMember[];
  readonly history: readonly StageHistoryEntry[];
  readonly qualification: readonly QualificationAnswer[];
  readonly target: LeadTarget;
  readonly editAction: (target: LeadTarget, formData: FormData) => Promise<void>;
  readonly answerAction: (target: LeadTarget, formData: FormData) => Promise<void>;
}

const KNOWN_SOURCES = new Set(["AI_SUGGESTED", "HUMAN_CONFIRMED", "HUMAN_SET"]);

export function LeadPanel({ t, lead, stages, members, history, qualification, target, editAction, answerAction }: LeadPanelProps) {
  // One shared rule for a stage's name, in `stage-name.ts`, rather than a copy per surface.
  const nameOfStage = (stage: StageDisplay) => stageName(t, stage);
  const labelOf = (stage: string) => stageNameOf(t, stages, stage);

  return (
    <section className="lead-panel" aria-labelledby="lead-panel-heading" data-lead-panel={lead.conversationId}>
      <h3 id="lead-panel-heading">{lead.contactName ?? lead.handle}</h3>

      <form action={editAction.bind(null, target)} className="knowledge-editor">
        <input type="hidden" name="conversationId" value={lead.conversationId} />

        <label htmlFor="lead-assignee">{t.t("leads.assignee")}</label>
        <select id="lead-assignee" name="assignedUserId" defaultValue={lead.assignedUserId ?? ""}>
          {/* An empty option is "nobody owns this", which is a real choice and not a missing value. */}
          <option value="">{t.t("leads.unassigned")}</option>
          {members.map((member) => (
            <option key={member.userId} value={member.userId}>
              {member.name ?? member.userId}
            </option>
          ))}
        </select>

        <label htmlFor="lead-tags">{t.t("leads.tags")}</label>
        <textarea id="lead-tags" name="tags" rows={2} defaultValue={lead.tags.join("\n")} />

        <label htmlFor="lead-note">{t.t("leads.note")}</label>
        <textarea id="lead-note" name="note" rows={2} defaultValue={lead.note ?? ""} />

        <label htmlFor="lead-next">{t.t("leads.nextAction")}</label>
        <input id="lead-next" name="nextAction" type="text" defaultValue={lead.nextAction ?? ""} />

        <label htmlFor="lead-next-at">{t.t("leads.nextActionAt")}</label>
        <input
          id="lead-next-at"
          name="nextActionAt"
          type="date"
          defaultValue={lead.nextActionAt === null ? "" : lead.nextActionAt.toISOString().slice(0, 10)}
        />

        <button className="button primary" type="submit" data-action="save-lead">
          {t.t("leads.save")}
        </button>
      </form>

      <h4>{t.t("leads.qualification")}</h4>
      {qualification.length === 0 ? (
        <p className="muted" data-qualification="empty">
          {t.t("leads.qualificationEmpty")}
        </p>
      ) : (
        <ul className="lead-answers">
          {qualification.map((answer) => (
            <li key={`${answer.criterion}:${answer.source}`} data-criterion={answer.criterion} data-source={answer.source}>
              <p className="muted">{answer.criterion}</p>
              <p>{answer.value}</p>
              {/* Whose claim this is. The assistant's reading and a person's answer sit side by side. */}
              <p className="muted">
                {sourceLabel(t, answer.source)}
                {answer.actorName === null ? "" : ` · ${answer.actorName}`}
              </p>
            </li>
          ))}
        </ul>
      )}

      <form action={answerAction.bind(null, target)} className="knowledge-editor">
        <input type="hidden" name="conversationId" value={lead.conversationId} />
        <label htmlFor="lead-criterion">{t.t("leads.criterion")}</label>
        <input id="lead-criterion" name="criterion" type="text" required />
        <label htmlFor="lead-answer">{t.t("leads.answer")}</label>
        <input id="lead-answer" name="answer" type="text" required />
        <button className="button" type="submit" data-action="record-answer">
          {t.t("leads.addAnswer")}
        </button>
      </form>

      <h4>{t.t("leads.history")}</h4>
      {history.length === 0 ? (
        <p className="muted" data-history="empty">
          {t.t("leads.historyEmpty")}
        </p>
      ) : (
        <ol className="lead-history">
          {history.map((entry) => (
            <li key={entry.id} data-transition={entry.id} data-source={entry.source}>
              <p>
                {entry.fromStage === null
                  ? t.t("leads.historyFirst", { to: labelOf(entry.toStage) })
                  : t.t("leads.historyEntry", { from: labelOf(entry.fromStage), to: labelOf(entry.toStage) })}
              </p>
              <p className="muted">
                {sourceLabel(t, entry.source)}
                {entry.actorName === null ? "" : ` · ${entry.actorName}`} ·{" "}
                <time dateTime={entry.changedAt.toISOString()}>{t.date(entry.changedAt, { dateStyle: "short", timeStyle: "short" })}</time>
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function sourceLabel(t: Translator, source: string): string {
  return KNOWN_SOURCES.has(source) ? t.t(`leadSource.${source}` as MessageKey) : source;
}
