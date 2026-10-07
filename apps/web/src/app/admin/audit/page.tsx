/**
 * The internal audit (#59, ADMIN_OPERATIONS.md).
 *
 * Separate from the customer's own audit log and deliberately not reachable from it: a customer must not
 * read internal actions, and `audit_events` could not have held them anyway — its `workspace_id` is NOT
 * NULL and `searchAuditEvents` authorizes through the customer's own context.
 */
import { PlatformAuditTable } from "@/ui/admin/platform-audit-table";
import { ADMIN_BASE_PATH, loadAdminAudit } from "@/server/admin-page";
import type { RawSearchParams } from "@/server/inbox-view";

export const dynamic = "force-dynamic";

export default async function AdminAuditPage({ searchParams }: { readonly searchParams: Promise<RawSearchParams> }) {
  const query = await searchParams;
  const data = await loadAdminAudit(query);
  const { t } = data;

  return (
    <div className="stack">
      <div className="page-header">
        <h1>{t.t("admin.auditTitle")}</h1>
        <a className="button" href={ADMIN_BASE_PATH} data-action="back-to-admin">
          {t.t("admin.title")}
        </a>
      </div>

      <PlatformAuditTable t={t} rows={data.rows} />

      {data.nextCursor === undefined ? undefined : (
        // Keyset paging: both halves of the cursor travel, because an instant with no tiebreak silently
        // repeats or skips rows as new ones land — and new ones land while an operator is reading.
        <a
          className="button"
          href={`${data.basePath}?since=${encodeURIComponent(data.nextCursor.occurredAt.toISOString())}&after=${encodeURIComponent(data.nextCursor.id)}`}
          data-action="audit-next"
        >
          {t.t("admin.auditNext")}
        </a>
      )}
    </div>
  );
}
