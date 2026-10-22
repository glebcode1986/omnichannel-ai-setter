/**
 * Opening, seeing and ending access to one customer's data (#59, ADMIN_OPERATIONS.md).
 *
 * Two things are deliberate in the markup.
 *
 * **The reason is required and the break-glass tick is separate.** A session nobody can explain is a
 * session nobody dares revoke, and break-glass is its own control rather than a longer duration, because
 * it is a different decision with a fifteen-minute ceiling and a CRITICAL audit row behind it.
 *
 * **The history is shown beside the form.** A chain of short grants is operationally standing access, so
 * the list of who has been in this workspace is the thing that makes a chain legible. The server counts
 * the actor's recent break-glass sessions into the audit row for the same reason.
 *
 * Every control is absent rather than disabled when the operator's role does not hold the permission —
 * this app's rule, and here also the honest one: the store refuses them whatever the page renders.
 */
import type { SupportSessionRow } from "@omnichannel/db";
import type { SupportScope } from "@omnichannel/domain";

import type { Translator } from "@/i18n/translate";

export function SupportAccess({
  t,
  workspaceId,
  sessions,
  scope,
  canOpen,
  canBreakGlass,
  actions,
}: {
  readonly t: Translator;
  readonly workspaceId: string;
  readonly sessions: readonly SupportSessionRow[];
  readonly scope: SupportScope;
  readonly canOpen: boolean;
  readonly canBreakGlass: boolean;
  readonly actions: { readonly open: (formData: FormData) => Promise<void>; readonly revoke: (formData: FormData) => Promise<void> };
}) {
  return (
    <section className="card" data-admin="support-access">
      <h2>{t.t("admin.supportAccess")}</h2>

      <p className="muted" data-scope-granted={scope.granted.length > 0} data-scope-refusal={scope.refusal ?? ""}>
        {scope.granted.length > 0 ? t.t("admin.scopeGranted") : t.t("admin.scopeNone")}
      </p>

      {canOpen ? (
        <form action={actions.open} className="stack" data-admin="open-session">
          <input type="hidden" name="workspaceId" value={workspaceId} />

          <label htmlFor="admin-session-reason">{t.t("admin.sessionReason")}</label>
          <input id="admin-session-reason" name="reason" type="text" required />

          <label htmlFor="admin-session-ticket">{t.t("admin.sessionTicket")}</label>
          <input id="admin-session-ticket" name="ticketRef" type="text" />

          {canBreakGlass ? (
            <label className="checkbox">
              <input type="checkbox" name="breakGlass" />
              {t.t("admin.breakGlass")}
            </label>
          ) : undefined}

          <button className="button primary" type="submit" data-action="open-session">
            {t.t("admin.openSession")}
          </button>
        </form>
      ) : (
        <p className="muted" data-admin="cannot-open-session">
          {t.t("admin.notYourRole")}
        </p>
      )}

      <h3>{t.t("admin.sessionHistory")}</h3>
      {sessions.length === 0 ? (
        <p className="muted" data-sessions="none">
          {t.t("admin.noSessions")}
        </p>
      ) : (
        <ul className="admin-sessions">
          {sessions.map((session) => (
            <li key={session.sessionId} data-session={session.sessionId} data-live={session.live} data-break-glass={session.breakGlass}>
              <p>
                {t.t("admin.sessionLine", {
                  actor: session.actorName ?? t.t("admin.unknownActor"),
                  role: session.actorRole,
                  started: t.date(session.startedAt, { dateStyle: "short", timeStyle: "short" }),
                  expires: t.date(session.expiresAt, { dateStyle: "short", timeStyle: "short" }),
                })}
              </p>
              <p className="muted">{session.reason}</p>
              {session.live && canOpen ? (
                <form action={actions.revoke} data-admin="revoke-session">
                  <input type="hidden" name="sessionId" value={session.sessionId} />
                  <label htmlFor={`admin-revoke-${session.sessionId}`} className="visually-hidden">
                    {t.t("admin.revokeReason")}
                  </label>
                  <input id={`admin-revoke-${session.sessionId}`} name="reason" type="text" aria-label={t.t("admin.revokeReason")} required />
                  <button className="button" type="submit" data-action="revoke-session">
                    {t.t("admin.revokeSession")}
                  </button>
                </form>
              ) : undefined}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
