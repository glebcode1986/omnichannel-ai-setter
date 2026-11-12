/**
 * The first thing a new customer can actually do (#115).
 *
 * Its own component rather than markup inside the route, for the reason `add-example-form.tsx` states: a
 * route component is the one thing a test in this app cannot call, and controls that went missing went
 * missing there.
 *
 * On the product's own field frame — `form-stack` holding a `form-grid` of `field`s — and not on
 * `knowledge-editor`, which is what it used to borrow: a class named after a different feature, on the
 * first form a new customer ever submits.
 *
 * `maxLength` and `required` are a courtesy to the person typing, not the rule. The rule is
 * `onboarding-submission.ts`, which refuses a blank or overlong name on a submission no browser built,
 * and the store refuses it again. An attribute on an input is a hint a constructed request never reads.
 */
import { NAME_MAX_LENGTH } from "@omnichannel/db";

import type { Translator } from "@/i18n/translate";

export interface CreateWorkspaceFormProps {
  readonly t: Translator;
  readonly action: (formData: FormData) => Promise<void>;
}

export function CreateWorkspaceForm({ t, action }: CreateWorkspaceFormProps) {
  return (
    <form action={action} className="form-stack" data-form="create-workspace">
      <div className="form-grid">
        <div className="field">
          <label htmlFor="workspace-name">{t.t("onboarding.workspaceNameLabel")}</label>
          <input id="workspace-name" name="name" type="text" required maxLength={NAME_MAX_LENGTH} autoComplete="organization" />
          <p className="muted">{t.t("onboarding.nameHint", { max: String(NAME_MAX_LENGTH) })}</p>
        </div>
      </div>

      <div className="form-actions">
        <button className="button" data-variant="primary" type="submit" data-action="create-workspace">
          {t.t("onboarding.createWorkspace")}
        </button>
      </div>
    </form>
  );
}
