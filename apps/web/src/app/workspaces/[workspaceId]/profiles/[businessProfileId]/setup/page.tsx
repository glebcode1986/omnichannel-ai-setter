/**
 * The resumable setup surface (ONBOARDING_UX.md, Issue #27).
 *
 * Everything shown is read now: the steps, the channel states and the checklist all come from one pass
 * over the profile's own configuration, so a reload cannot show a person progress they do not have, and
 * cannot lose progress they do.
 *
 * The role decides which controls appear, and the server actions decide whether they work. Those are
 * deliberately two different mechanisms — the first is a courtesy, the second is the boundary.
 */
import { readOnboarding, WORKSPACE_ADMIN_ROLES } from "@omnichannel/db";

import { ChannelCards } from "@/ui/channel-cards";
import { SetupChecklist } from "@/ui/setup-checklist";
import { requestTranslator } from "@/i18n/request-locale";
import { activateAction, restoreStepAction, skipStepAction } from "@/server/setup-actions";
import { getDb } from "@/server/db";
import { requireBusinessProfileContext } from "@/server/request-context";

export default async function SetupPage({
  params,
}: {
  readonly params: Promise<{ readonly workspaceId: string; readonly businessProfileId: string }>;
}) {
  const { workspaceId, businessProfileId } = await params;
  const context = await requireBusinessProfileContext(workspaceId, businessProfileId);
  const { facts, state } = await readOnboarding(getDb(), context);
  const t = await requestTranslator();

  const canConfigure = WORKSPACE_ADMIN_ROLES.includes(context.role);
  const target = { workspaceId, businessProfileId };
  const connectPath = `/api/workspaces/${workspaceId}/business-profiles/${businessProfileId}/channels/instagram/connect`;

  return (
    <div className="stack">
      <div className="page-header">
        <h1>{t.t("setup.title")}</h1>
      </div>

      <ChannelCards
        t={t}
        channels={facts.channels}
        offered={["INSTAGRAM"]}
        {...(canConfigure ? { instagramConnectPath: connectPath } : {})}
      />

      <SetupChecklist
        t={t}
        state={state}
        canConfigure={canConfigure}
        activated={facts.activated}
        skipAction={skipStepAction.bind(null, target)}
        unskipAction={restoreStepAction.bind(null, target)}
        activateAction={activateAction.bind(null, target)}
      />
    </div>
  );
}
