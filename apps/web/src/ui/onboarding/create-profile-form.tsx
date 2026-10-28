/**
 * Adding the Business Profile the whole product hangs off (#115).
 *
 * Rendered only for a membership that may create one, and that is a *courtesy*: the boundary is
 * `createBusinessProfileAction`, which re-resolves the role from the database on every call, and the
 * store refuses again inside its own transaction. An AGENT who constructs the request gets
 * `WorkspacePermissionError` whether or not this component drew a button for them.
 *
 * When the control is withheld the reason is said out loud instead of leaving a blank space, because "I
 * cannot find where to add a profile" and "I am not allowed to" are different problems and only one of
 * them is worth asking an administrator about.
 */
import { NAME_MAX_LENGTH } from "@omnichannel/db";

import type { Translator } from "@/i18n/translate";

export interface CreateProfileFormProps {
  readonly t: Translator;
  readonly action: (formData: FormData) => Promise<void>;
  /** Whether this membership may create a profile: OWNER, or an ADMIN whose scope is every profile. */
  readonly allowed: boolean;
}

export function CreateProfileForm({ t, action, allowed }: CreateProfileFormProps) {
  if (!allowed) {
    return (
      <p className="muted" data-form="create-profile-withheld">
        {t.t("onboarding.createProfileForbidden")}
      </p>
    );
  }

  return (
    <form action={action} className="knowledge-editor" data-form="create-profile">
      <label htmlFor="profile-name">{t.t("onboarding.profileNameLabel")}</label>
      <input id="profile-name" name="name" type="text" required maxLength={NAME_MAX_LENGTH} />
      <p className="muted">{t.t("onboarding.nameHint", { max: String(NAME_MAX_LENGTH) })}</p>

      <button className="button primary" type="submit" data-action="create-profile">
        {t.t("onboarding.createProfile")}
      </button>
    </form>
  );
}
