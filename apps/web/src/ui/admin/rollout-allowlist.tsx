/**
 * Selecting which Business Profiles may send unattended during a limited rollout (#60, §18 stage three).
 *
 * §18's third stage is "limited AUTOPILOT on explicitly selected BPs". Before this pane the selecting had
 * no interface at all: the column existed, the delivery claim read it under a row lock, and the only way
 * to set it was hand-written SQL against production — which is the practice the operator console exists
 * to end, and the thing the previous slice's own commit message was about.
 *
 * The pane is deliberate about what the control does **not** do. Adding a profile here does not switch
 * unattended sending on. The rollout has to have reached that stage, the plan has to permit autopilot,
 * the profile has to be in AUTOPILOT, and no kill switch may cover it. So the note is part of the pane
 * rather than a tooltip: a checkbox that reads as "turn sending on" would be a control whose label
 * promises more than any one condition can deliver.
 *
 * Two forms rather than one checkbox, because an unchecked checkbox submits nothing — a single toggle
 * would have made "remove from the list" indistinguishable from "the browser did not send the field".
 */
import type { ProfileDiagnostic } from "@omnichannel/db";

import type { Translator } from "@/i18n/translate";

export function RolloutAllowlist({
  t,
  workspaceId,
  profiles,
  canOperate,
  action,
}: {
  readonly t: Translator;
  readonly workspaceId: string;
  readonly profiles: readonly ProfileDiagnostic[];
  readonly canOperate: boolean;
  readonly action: (formData: FormData) => Promise<void>;
}) {
  return (
    <section className="card" data-admin="rollout-allowlist">
      <h2>{t.t("admin.rolloutAutopilot")}</h2>
      <p className="muted" data-admin="rollout-note">
        {t.t("admin.rolloutAutopilotNote")}
      </p>

      <ul className="admin-profiles">
        {profiles.map((profile) => (
          <li key={profile.businessProfileId} data-profile={profile.businessProfileId} data-allowlisted={profile.rolloutAutopilot}>
            <p>
              {profile.name} — {profile.rolloutAutopilot ? t.t("admin.rolloutAutopilotOn") : t.t("admin.rolloutAutopilotOff")}
            </p>
            {canOperate ? (
              <form action={action} data-admin="rollout-toggle">
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="businessProfileId" value={profile.businessProfileId} />
                {/* Present for an addition and absent for a removal, which is what makes the two
                    distinguishable at all; see the header. */}
                {profile.rolloutAutopilot ? undefined : <input type="hidden" name="enabled" value="on" />}
                <label htmlFor={`admin-rollout-${profile.businessProfileId}`} className="visually-hidden">
                  {t.t("admin.rolloutAutopilotReason")}
                </label>
                <input
                  id={`admin-rollout-${profile.businessProfileId}`}
                  name="reason"
                  type="text"
                  aria-label={t.t("admin.rolloutAutopilotReason")}
                  required
                />
                <button className="button" type="submit" data-action={profile.rolloutAutopilot ? "rollout-remove" : "rollout-add"}>
                  {profile.rolloutAutopilot ? t.t("admin.rolloutAutopilotRemove") : t.t("admin.rolloutAutopilotAdd")}
                </button>
              </form>
            ) : undefined}
          </li>
        ))}
      </ul>

      {canOperate ? undefined : (
        <p className="muted" data-admin="cannot-operate-rollout">
          {t.t("admin.notYourRole")}
        </p>
      )}
    </section>
  );
}
