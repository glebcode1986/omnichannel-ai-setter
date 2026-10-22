/**
 * The internal audit, as a table (#59, ADMIN_OPERATIONS.md).
 *
 * Every operator sees every operator's actions, including the CRITICAL ones and including their own. A log
 * where staff cannot see each other's actions protects staff rather than customers, which is backwards —
 * what gates this page is holding `READ_PLATFORM_AUDIT` at all.
 *
 * Severity is shown because it is the column somebody scans: the two CRITICAL kinds are the two acts that
 * are indistinguishable from an attack if nobody authorised them.
 */
import type { PlatformAuditRow } from "@omnichannel/db";

import type { MessageKey } from "@/i18n/catalogue";
import type { Translator } from "@/i18n/translate";

export function PlatformAuditTable({ t, rows }: { readonly t: Translator; readonly rows: readonly PlatformAuditRow[] }) {
  return (
    <section className="card" data-admin="audit">
      <h2>{t.t("admin.auditTitle")}</h2>

      {rows.length === 0 ? (
        <p className="muted" data-audit="none">
          {t.t("admin.noAudit")}
        </p>
      ) : (
        <table className="admin-audit">
          <thead>
            <tr>
              <th scope="col">{t.t("admin.auditWhen")}</th>
              <th scope="col">{t.t("admin.auditWho")}</th>
              <th scope="col">{t.t("admin.auditWhat")}</th>
              <th scope="col">{t.t("admin.auditWhy")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} data-audit-row={row.id} data-severity={row.severity} data-kind={row.kind}>
                <td>{t.date(row.occurredAt, { dateStyle: "short", timeStyle: "short" })}</td>
                <td>{t.t("admin.auditActor", { actor: row.actorName ?? t.t("admin.unknownActor"), role: row.actorRole })}</td>
                <td>{t.t(`platformAudit.${row.kind}` as MessageKey)}</td>
                <td>{row.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
