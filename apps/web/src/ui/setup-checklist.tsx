/**
 * The setup steps and the activation checklist (ONBOARDING_UX.md).
 *
 * Two surfaces that answer different questions and are deliberately not merged. The step list answers
 * "what is there left to do"; the checklist answers "may this business start answering customers". Style
 * appears in the first and not the second, which is exactly the distinction the spec draws when it asks
 * for style "configured or intentionally skipped".
 *
 * Every action is a form posting to a server action. The buttons reflect the viewer's role, but nothing
 * here is the authorization: the server re-checks it, because a disabled button is a hint and not a
 * boundary.
 */
import type { OnboardingState, OnboardingStep } from "@omnichannel/domain";

import type { MessageKey } from "@/i18n/catalogue";
import type { Translator } from "@/i18n/translate";

const stepStateTones: Readonly<Record<string, "ok" | "muted" | "warn">> = {
  COMPLETE: "ok",
  SKIPPED: "muted",
  INCOMPLETE: "warn",
};

export interface SetupChecklistProps {
  readonly t: Translator;
  readonly state: OnboardingState;
  /** Whether this viewer may change setup. Owners and admins may; everyone else reads. */
  readonly canConfigure: boolean;
  readonly activated: boolean;
  /** Server action that records a deliberate skip. */
  readonly skipAction: (formData: FormData) => void | Promise<void>;
  readonly unskipAction: (formData: FormData) => void | Promise<void>;
  readonly activateAction: (formData: FormData) => void | Promise<void>;
  /** Shown when an action was refused because the setup moved while the page was open. */
  readonly staleNotice?: boolean;
}

export function SetupChecklist({
  t,
  state,
  canConfigure,
  activated,
  skipAction,
  unskipAction,
  activateAction,
  staleNotice = false,
}: SetupChecklistProps) {
  return (
    <div className="stack">
      {staleNotice ? (
        <p className="notice" data-tone="stop" role="status">
          {t.t("setup.staleAction")}
        </p>
      ) : undefined}

      <section aria-labelledby="steps-heading" className="stack">
        <h2 id="steps-heading">{t.t("setup.title")}</h2>
        <p className="muted">{t.t("setup.subtitle")}</p>
        <p>{state.nextStep === undefined ? t.t("setup.allDone") : t.t("setup.resumeHint", { step: t.t(`step.${state.nextStep}` as MessageKey) })}</p>
        <ol className="step-list">
          {state.steps.map((status) => (
            <li className="step" key={status.step} data-current={String(status.step === state.nextStep)} data-step={status.step}>
              <span className="step-name">{t.t(`step.${status.step}` as MessageKey)}</span>
              <span className="badge" data-tone={stepStateTones[status.state]}>
                {t.t(`stepState.${status.state}` as MessageKey)}
              </span>
              <span className="muted" style={{ flexBasis: "100%" }}>
                {t.t(`stepDescription.${status.step}` as MessageKey)}
              </span>
              {renderSkipControl(t, status.step, status.state, status.skippable, canConfigure, skipAction, unskipAction)}
            </li>
          ))}
        </ol>
        {canConfigure ? undefined : <p className="muted">{t.t("setup.skipRestricted")}</p>}
      </section>

      <section aria-labelledby="checklist-heading" className="stack">
        <h2 id="checklist-heading">{t.t("setup.checklistTitle")}</h2>
        {activated ? (
          <p className="notice" role="status">
            {t.t("setup.activated")}
          </p>
        ) : state.activationBlockers.length === 0 ? (
          <p>{t.t("setup.checklistReady")}</p>
        ) : (
          <ul className="blockers">
            {state.activationBlockers.map((blocker) => (
              <li key={blocker} data-blocker={blocker}>
                {t.t(`blocker.${blocker}` as MessageKey)}
              </li>
            ))}
          </ul>
        )}
        {activated ? undefined : (
          <form action={activateAction}>
            <button
              className="button"
              data-variant="primary"
              type="submit"
              // Disabled for two different reasons, and the title says which: an unfinished checklist, or
              // a role that may not activate. A single greyed-out button with no explanation is the thing
              // a non-technical owner cannot get past.
              disabled={!state.canActivate || !canConfigure}
              title={canConfigure ? undefined : t.t("setup.activationDenied")}
            >
              {t.t("setup.activate")}
            </button>
          </form>
        )}
        {canConfigure ? undefined : <p className="muted">{t.t("setup.activationDenied")}</p>}
      </section>
    </div>
  );
}

function renderSkipControl(
  t: Translator,
  step: OnboardingStep,
  stepState: OnboardingState["steps"][number]["state"],
  skippable: boolean,
  canConfigure: boolean,
  skipAction: (formData: FormData) => void | Promise<void>,
  unskipAction: (formData: FormData) => void | Promise<void>,
) {
  if (!skippable || !canConfigure || stepState === "COMPLETE") {
    return undefined;
  }
  const skipped = stepState === "SKIPPED";
  return (
    <form action={skipped ? unskipAction : skipAction}>
      <input type="hidden" name="step" value={step} />
      <button className="button" type="submit">
        {skipped ? t.t("setup.undoSkip") : t.t("setup.skip")}
      </button>
    </form>
  );
}
