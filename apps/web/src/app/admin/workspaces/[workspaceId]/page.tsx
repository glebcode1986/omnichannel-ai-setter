/**
 * One tenant, as an operator sees it (#59, ADMIN_OPERATIONS.md).
 *
 * Metadata by default: the summary carries identifiers, capability state, commercial state, timings and
 * counts, and `SupportSnapshot` has no field for a customer's words. Reading those is one link away and
 * needs a session, which the support-access pane is for.
 */
import { KillSwitches } from "@/ui/admin/kill-switches";
import { ReconciliationQueue } from "@/ui/admin/reconciliation-queue";
import { RolloutAllowlist } from "@/ui/admin/rollout-allowlist";
import { SupportAccess } from "@/ui/admin/support-access";
import { WorkspaceSummary } from "@/ui/admin/workspace-summary";
import { OutcomeNotice } from "@/ui/outcome-notice";
import {
  liftKillSwitchAction,
  openSupportSessionAction,
  pullKillSwitchAction,
  reexamineOperationAction,
  revokeSupportSessionAction,
  setRolloutAutopilotAction,
} from "@/server/admin-actions";
import { ADMIN_BASE_PATH, loadAdminWorkspace } from "@/server/admin-page";
import type { RawSearchParams } from "@/server/inbox-view";
import { one } from "@/server/style-view";

export const dynamic = "force-dynamic";

export default async function AdminWorkspacePage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly workspaceId: string }>;
  readonly searchParams: Promise<RawSearchParams>;
}) {
  const { workspaceId } = await params;
  const query = await searchParams;
  const data = await loadAdminWorkspace(workspaceId);
  const { t } = data;
  const path = `${ADMIN_BASE_PATH}/workspaces/${workspaceId}`;

  return (
    <div className="stack">
      <div className="page-header">
        <h1>{t.t("admin.title")}</h1>
        <a className="button" href={ADMIN_BASE_PATH} data-action="back-to-admin">
          {t.t("admin.lookupTitle")}
        </a>
      </div>

      <OutcomeNotice t={t} outcome={one(query["outcome"])} />

      {data.snapshot === undefined ? (
        // No such tenant. A different answer from "something failed", which is why the read returns null.
        <p className="notice" data-tone="stop" data-admin="unknown-workspace">
          {t.t("admin.lookupEmpty")}
        </p>
      ) : (
        <>
          <WorkspaceSummary t={t} snapshot={data.snapshot} />

          <RolloutAllowlist
            t={t}
            workspaceId={workspaceId}
            profiles={data.snapshot.profiles}
            canOperate={data.can.OPERATE_RELEASE}
            action={setRolloutAutopilotAction.bind(null, path)}
          />

          <SupportAccess
            t={t}
            workspaceId={workspaceId}
            sessions={data.sessions}
            scope={data.scope}
            canOpen={data.can.OPEN_SUPPORT_SESSION}
            canBreakGlass={data.can.BREAK_GLASS}
            actions={{
              open: openSupportSessionAction.bind(null, path),
              revoke: revokeSupportSessionAction.bind(null, path),
            }}
          />

          <section className="card" data-admin="conversations">
            <h2>{t.t("admin.conversation")}</h2>
            {/* The link to the one content-bearing screen. Present whatever the session grants, because
                the screen itself says what would unlock it — a link that disappeared would leave an
                operator guessing whether the conversation exists. */}
            <ul className="admin-profiles">
              {data.snapshot.profiles.map((profile) => (
                <li key={profile.businessProfileId}>
                  <a
                    href={`${path}/conversations/${profile.businessProfileId}/${one(query["conversation"]) ?? ""}`}
                    data-action="open-conversation"
                  >
                    {profile.name}
                  </a>
                </li>
              ))}
            </ul>
          </section>

          <KillSwitches
            t={t}
            switches={data.killSwitches}
            workspaceId={workspaceId}
            canOperate={data.can.OPERATE_KILL_SWITCH}
            actions={{ pull: pullKillSwitchAction.bind(null, path), lift: liftKillSwitchAction.bind(null, path) }}
          />

          <ReconciliationQueue
            t={t}
            rows={data.reconciliations}
            canOperate={data.can.OPERATE_RECONCILIATION}
            action={reexamineOperationAction.bind(null, path)}
            workspacePath={(id) => `${ADMIN_BASE_PATH}/workspaces/${id}`}
          />
        </>
      )}
    </div>
  );
}
