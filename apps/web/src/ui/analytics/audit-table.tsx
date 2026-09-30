/**
 * The audit log on screen (LEADS_ANALYTICS_UX.md, Issue #34).
 *
 * Newest first, one row per action, and the page states two things it would otherwise be reasonable to
 * assume the other way about:
 *
 * **These records cannot be edited.** Said out loud, because a log a reader believes is editable is a log
 * they discount. The database enforces it with a trigger; this is where the reader is told.
 *
 * **Some rows may be missing.** An Agent sees a banner saying owners and admins see more. That is not a
 * redaction — the rows are genuinely absent from their query — but a reader who did not know would draw
 * conclusions from a gap, and telling them costs nothing that hiding it protects.
 */
import type { AuditEventView } from "@omnichannel/db";

import type { Translator } from "@/i18n/translate";

export interface AuditTableProps {
  readonly t: Translator;
  readonly rows: readonly AuditEventView[];
  /** True when this reader's role withholds some kinds. */
  readonly restricted: boolean;
  /** A link to the next page, already carrying the reader's filters. Absent on the last page. */
  readonly olderHref?: string;
  readonly timeZone: string;
}

export function AuditTable({ t, rows, restricted, olderHref, timeZone }: AuditTableProps) {
  const when = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  return (
    <div className="audit-log" data-audit-log="true">
      <p className="notice" data-append-only="true">
        {t.t("audit.appendOnly")}
      </p>
      {restricted ? (
        <p className="muted" data-restricted="true">
          {t.t("audit.restricted")}
        </p>
      ) : undefined}
      {rows.length === 0 ? (
        <p className="muted">{t.t("audit.empty")}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">{t.t("audit.when")}</th>
              <th scope="col">{t.t("audit.kind")}</th>
              <th scope="col">{t.t("audit.who")}</th>
              <th scope="col">{t.t("audit.what")}</th>
              <th scope="col">{t.t("audit.subject")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} data-kind={row.kind}>
                {/* Shown in the same zone the reader chose for the metrics, so the two screens agree. */}
                <td>{when.format(row.occurredAt)}</td>
                <td>{t.t(`audit.kind.${row.kind}`)}</td>
                {/* Reconciliation and the scheduler act on their own. Naming a person would be a lie. */}
                <td>{row.actorName ?? t.t("audit.system")}</td>
                <td>{row.summary}</td>
                <td className="muted">{`${row.subjectType} ${row.subjectId}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {olderHref === undefined ? undefined : (
        <a className="audit-older" href={olderHref} data-audit-older="true">
          {t.t("audit.older")}
        </a>
      )}
    </div>
  );
}
