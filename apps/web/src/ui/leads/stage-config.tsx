/**
 * Renaming, reordering and hiding the board's columns (LEADS_ANALYTICS_UX.md, Issue #33).
 *
 * One row per internal stage, and the internal id is shown beside the label an operator chooses — because
 * the whole point of separating them is that a rename must never look like a change to what a stage
 * *means*. The draft engine returns a `LeadStage` in its structured output and the policy engine reads
 * one; a Workspace's label sits on top of that and nowhere near it.
 *
 * There is no "add a stage" control, and that is a limit rather than an omission: a new internal id would
 * be a change to what the model may return, which is a decision about the product and not about a board.
 * The form says nothing about it; the PR says it out loud.
 */
import type { StageDisplay } from "@omnichannel/db";

import type { Translator } from "@/i18n/translate";
import type { LeadTarget } from "@/server/lead-actions";

export interface StageConfigProps {
  readonly t: Translator;
  readonly stages: readonly StageDisplay[];
  readonly target: LeadTarget;
  readonly action: (target: LeadTarget, formData: FormData) => Promise<void>;
}

export function StageConfig({ t, stages, target, action }: StageConfigProps) {
  return (
    <details className="stage-config">
      <summary>{t.t("stages.title")}</summary>
      <form action={action.bind(null, target)}>
        <p className="muted">{t.t("stages.hint")}</p>
        <table>
          <thead>
            <tr>
              <th scope="col">{t.t("stages.internalId")}</th>
              <th scope="col">{t.t("stages.label")}</th>
              <th scope="col">{t.t("stages.position")}</th>
              <th scope="col">{t.t("stages.hidden")}</th>
            </tr>
          </thead>
          <tbody>
            {stages.map((stage) => (
              <tr key={stage.stage} data-stage={stage.stage}>
                {/* The internal id, shown and not editable: it is the contract with the draft engine. */}
                <th scope="row">
                  <code>{stage.stage}</code>
                </th>
                <td>
                  <label className="visually-hidden" htmlFor={`label_${stage.stage}`}>
                    {t.t("stages.label")}
                  </label>
                  <input id={`label_${stage.stage}`} name={`label_${stage.stage}`} type="text" defaultValue={stage.label} required />
                </td>
                <td>
                  <label className="visually-hidden" htmlFor={`position_${stage.stage}`}>
                    {t.t("stages.position")}
                  </label>
                  <input id={`position_${stage.stage}`} name={`position_${stage.stage}`} type="number" min="0" defaultValue={stage.position} />
                </td>
                <td>
                  <label className="visually-hidden" htmlFor={`hidden_${stage.stage}`}>
                    {t.t("stages.hidden")}
                  </label>
                  <input id={`hidden_${stage.stage}`} name={`hidden_${stage.stage}`} type="checkbox" defaultChecked={stage.hidden} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">{t.t("stages.hiddenHint")}</p>
        <button className="button primary" type="submit" data-action="save-stages">
          {t.t("stages.save")}
        </button>
      </form>
    </details>
  );
}
