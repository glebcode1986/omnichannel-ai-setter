/**
 * The internal operations console's front page (#59, ADMIN_OPERATIONS.md).
 *
 * A separate route tree from the product, authorized by a separate path. No customer context is in scope
 * here at all, and `route-authorization.test.ts` fails the build if one ever is — an operator holding a
 * `WorkspaceContext` would hold customer OWNER authority, which is the thing the separate brand prevents.
 *
 * Three things on one page, because they are what an operator opens the console *for*: find a tenant,
 * see what is paused platform-wide, and see what is waiting to be settled.
 */
import { KillSwitches } from "@/ui/admin/kill-switches";
import { ReconciliationQueue } from "@/ui/admin/reconciliation-queue";
import { WorkspaceLookup } from "@/ui/admin/workspace-lookup";
import { OutcomeNotice } from "@/ui/outcome-notice";
import { liftKillSwitchAction, pullKillSwitchAction, reexamineOperationAction } from "@/server/admin-actions";
import { ADMIN_BASE_PATH, loadAdminHome } from "@/server/admin-page";
import type { RawSearchParams } from "@/server/inbox-view";
import { one } from "@/server/style-view";

export const dynamic = "force-dynamic";

export default async function AdminHomePage({ searchParams }: { readonly searchParams: Promise<RawSearchParams> }) {
  const query = await searchParams;
  const data = await loadAdminHome(query);
  const { t } = data;

  return (
    <div className="stack">
      <div className="page-header">
        <h1>{t.t("admin.title")}</h1>
        <a className="button" href={`${ADMIN_BASE_PATH}/releases`} data-action="open-releases">
          {t.t("admin.releases")}
        </a>
        <a className="button" href={`${ADMIN_BASE_PATH}/audit`} data-action="open-audit">
          {t.t("admin.audit")}
        </a>
      </div>

      <p className="muted" data-admin-role={data.role}>
        {t.t("admin.role", { role: data.role })}
      </p>

      <OutcomeNotice t={t} outcome={one(query["outcome"])} />

      <WorkspaceLookup t={t} term={data.term} hits={data.hits} basePath={ADMIN_BASE_PATH} />

      <KillSwitches
        t={t}
        switches={data.killSwitches}
        canOperate={data.can.OPERATE_KILL_SWITCH}
        actions={{
          pull: pullKillSwitchAction.bind(null, ADMIN_BASE_PATH),
          lift: liftKillSwitchAction.bind(null, ADMIN_BASE_PATH),
        }}
      />

      <ReconciliationQueue
        t={t}
        rows={data.reconciliations}
        canOperate={data.can.OPERATE_RECONCILIATION}
        action={reexamineOperationAction.bind(null, ADMIN_BASE_PATH)}
        workspacePath={(workspaceId) => `${ADMIN_BASE_PATH}/workspaces/${workspaceId}`}
      />
    </div>
  );
}
