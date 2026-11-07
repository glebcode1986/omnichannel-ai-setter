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
import { channelOffer } from "@/server/channel-offer";
import { getDb } from "@/server/db";
import { pageBusinessProfileContext } from "@/server/page-context";

export default async function SetupPage({
  params,
}: {
  readonly params: Promise<{ readonly workspaceId: string; readonly businessProfileId: string }>;
}) {
  const { workspaceId, businessProfileId } = await params;
  const context = await pageBusinessProfileContext(workspaceId, businessProfileId);
  const { facts, state } = await readOnboarding(getDb(), context);
  const t = await requestTranslator();

  const canConfigure = WORKSPACE_ADMIN_ROLES.includes(context.role);
  const target = { workspaceId, businessProfileId };
  // Which channels this reader and this deployment can actually start, decided in one place that the
  // channels screen reads too, so the two cannot answer differently again.
  const { offered, connect } = channelOffer(target, context);

  return (
    <div className="stack">
      <div className="page-header">
        <h1>{t.t("setup.title")}</h1>
      </div>

      <ChannelCards t={t} channels={facts.channels} offered={offered} connect={connect} />

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
