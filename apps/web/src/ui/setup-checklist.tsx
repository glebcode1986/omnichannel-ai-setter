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
import { activationBlockerLabels, setupText, stepDescriptions, stepLabels, stepStateLabels, stepStateTones } from "./labels";
import type { OnboardingState, OnboardingStep } from "@omnichannel/domain";

export interface SetupChecklistProps {
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
          {setupText.staleAction}
        </p>
      ) : undefined}

      <section aria-labelledby="steps-heading" className="stack">
        <h2 id="steps-heading">{setupText.title}</h2>
        <p className="muted">{setupText.subtitle}</p>
        <p>{state.nextStep === undefined ? setupText.allDone : setupText.resumeHint(stepLabels[state.nextStep])}</p>
        <ol className="step-list">
          {state.steps.map((status) => (
            <li className="step" key={status.step} data-current={String(status.step === state.nextStep)} data-step={status.step}>
              <span className="step-name">{stepLabels[status.step]}</span>
              <span className="badge" data-tone={stepStateTones[status.state]}>
                {stepStateLabels[status.state]}
              </span>
              <span className="muted" style={{ flexBasis: "100%" }}>
                {stepDescriptions[status.step]}
              </span>
              {renderSkipControl(status.step, status.state, status.skippable, canConfigure, skipAction, unskipAction)}
            </li>
          ))}
        </ol>
        {canConfigure ? undefined : <p className="muted">{setupText.skipRestricted}</p>}
      </section>

      <section aria-labelledby="checklist-heading" className="stack">
        <h2 id="checklist-heading">{setupText.checklistTitle}</h2>
        {activated ? (
          <p className="notice" role="status">
            {setupText.activated}
          </p>
        ) : state.activationBlockers.length === 0 ? (
          <p>{setupText.checklistReady}</p>
        ) : (
          <ul className="blockers">
            {state.activationBlockers.map((blocker) => (
              <li key={blocker} data-blocker={blocker}>
                {activationBlockerLabels[blocker]}
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
              title={canConfigure ? undefined : setupText.activationDenied}
            >
              {setupText.activate}
            </button>
          </form>
        )}
        {canConfigure ? undefined : <p className="muted">{setupText.activationDenied}</p>}
      </section>
    </div>
  );
}

function renderSkipControl(
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
        {skipped ? setupText.undoSkip : setupText.skip}
      </button>
    </form>
  );
}
