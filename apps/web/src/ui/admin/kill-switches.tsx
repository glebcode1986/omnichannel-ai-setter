/**
 * Pulling and lifting the automated-outbound switch (#59, RELIABILITY_INCIDENTS.md).
 *
 * This replaces a SQL prompt. `suspension-store.ts` says in its own comments that the documented way to
 * pull this today is an operator running SQL during an incident, which is exactly the "routine direct
 * production-DB editing" issue #59 exists to remove.
 *
 * Two facts the page states rather than implies. **Inbound keeps running**: nothing about a suspension is
 * consulted on the inbound path, so messages still arrive and are still stored while outbound is held.
 * And **the system's own pause cannot be lifted here** — the backlog guard raised it to protect the
 * queue, and a console overruling that would be overruling the machinery; the store refuses it, and the
 * list marks it so nobody looks for the control.
 */
import type { KillSwitchRow } from "@omnichannel/db";
import { SUSPENSION_SCOPES } from "@omnichannel/domain";

import type { MessageKey } from "@/i18n/catalogue";
import type { Translator } from "@/i18n/translate";

export function KillSwitches({
  t,
  switches,
  workspaceId,
  canOperate,
  actions,
}: {
  readonly t: Translator;
  readonly switches: readonly KillSwitchRow[];
  /** Pre-fills the narrow scopes when the console is looking at one tenant. */
  readonly workspaceId?: string;
  readonly canOperate: boolean;
  readonly actions: { readonly pull: (formData: FormData) => Promise<void>; readonly lift: (formData: FormData) => Promise<void> };
}) {
  return (
    <section className="card" data-admin="kill-switches">
      <h2>{t.t("admin.killSwitches")}</h2>
      <p className="muted" data-admin="inbound-unaffected">
        {t.t("admin.inboundKeepsRunning")}
      </p>

      {switches.length === 0 ? (
        <p className="muted" data-switches="none">
          {t.t("admin.nothingPaused")}
        </p>
      ) : (
        <ul className="admin-switches">
          {switches.map((row) => (
            <li key={row.suspensionId} data-switch={row.suspensionId} data-scope={row.scope} data-by-operator={row.byOperator}>
              <p>
                {t.t("admin.switchLine", {
                  scope: t.t(`suspensionScope.${row.scope}` as MessageKey),
                  reason: t.t(`suspensionReason.${row.reason}` as MessageKey),
                  since: t.date(row.since, { dateStyle: "short", timeStyle: "short" }),
                })}
              </p>
              {row.note === null ? undefined : <p className="muted">{row.note}</p>}
              {!row.byOperator ? (
                // The system's own. Said here so nobody goes looking for the button.
                <p className="muted" data-switch-owner="system">
                  {t.t("admin.systemPause")}
                </p>
              ) : canOperate ? (
                <form action={actions.lift} data-admin="lift-switch">
                  <input type="hidden" name="suspensionId" value={row.suspensionId} />
                  <label htmlFor={`admin-lift-${row.suspensionId}`} className="visually-hidden">
                    {t.t("admin.liftReason")}
                  </label>
                  <input id={`admin-lift-${row.suspensionId}`} name="reason" type="text" aria-label={t.t("admin.liftReason")} required />
                  <button className="button" type="submit" data-action="lift-switch">
                    {t.t("admin.liftSwitch")}
                  </button>
                </form>
              ) : undefined}
            </li>
          ))}
        </ul>
      )}

      {canOperate ? (
        <form action={actions.pull} className="stack" data-admin="pull-switch">
          <label htmlFor="admin-switch-scope">{t.t("admin.switchScope")}</label>
          <select id="admin-switch-scope" name="scope" defaultValue="WORKSPACE">
            {SUSPENSION_SCOPES.map((scope) => (
              <option key={scope} value={scope}>
                {t.t(`suspensionScope.${scope}` as MessageKey)}
              </option>
            ))}
          </select>

          {/* The narrow scopes need their identifiers, and the domain refuses a scope whose identifiers
              disagree with it — a profile-scoped pause with no profile named is a global stop wearing a
              narrow label. */}
          <label htmlFor="admin-switch-workspace">{t.t("admin.switchWorkspace")}</label>
          <input id="admin-switch-workspace" name="workspaceId" type="text" defaultValue={workspaceId ?? ""} />

          <label htmlFor="admin-switch-profile">{t.t("admin.switchProfile")}</label>
          <input id="admin-switch-profile" name="businessProfileId" type="text" />

          <label htmlFor="admin-switch-account">{t.t("admin.switchAccount")}</label>
          <input id="admin-switch-account" name="channelAccountId" type="text" />

          <label htmlFor="admin-switch-reason">{t.t("admin.switchReason")}</label>
          <input id="admin-switch-reason" name="reason" type="text" required />

          <button className="button primary" type="submit" data-action="pull-switch">
            {t.t("admin.pullSwitch")}
          </button>
        </form>
      ) : (
        <p className="muted" data-admin="cannot-operate-switch">
          {t.t("admin.notYourRole")}
        </p>
      )}
    </section>
  );
}
