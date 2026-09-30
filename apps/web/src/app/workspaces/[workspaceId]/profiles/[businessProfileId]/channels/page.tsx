/**
 * The channel connection surface.
 *
 * This is the route the Instagram callback already redirects to — `connectedRedirectUrl` in
 * `server/instagram.ts` builds exactly this path — so the page exists where the backend already expects
 * it rather than at a new address invented here. The `?instagram=` parameter it arrives with is the
 * outcome of the authorization attempt, and it is rendered as an actionable connection state rather than
 * a generic error.
 */
import { readOnboarding, WORKSPACE_ADMIN_ROLES } from "@omnichannel/db";

import { ChannelCards } from "@/ui/channel-cards";
import { requestTranslator } from "@/i18n/request-locale";
import type { MessageKey } from "@/i18n/catalogue";
import { getDb } from "@/server/db";
import { requireBusinessProfileContext } from "@/server/request-context";

/** What the callback can report. Each has its own message, because "it failed" is not actionable. */
const CONNECT_OUTCOMES = ["connected", "denied", "expired", "invalid", "failed"] as const;

export default async function ChannelsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly workspaceId: string; readonly businessProfileId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId, businessProfileId } = await params;
  const context = await requireBusinessProfileContext(workspaceId, businessProfileId);
  const { facts } = await readOnboarding(getDb(), context);
  const t = await requestTranslator();
  const outcome = (await searchParams).instagram;
  // Only outcomes this product knows about become messages: a query parameter is attacker-controlled, and
  // echoing an unknown one would be rendering a stranger's text inside the shell.
  const known = typeof outcome === "string" && (CONNECT_OUTCOMES as readonly string[]).includes(outcome) ? outcome : undefined;
  const message = known === undefined ? undefined : t.t(`connect.${known}` as MessageKey);

  const canConfigure = WORKSPACE_ADMIN_ROLES.includes(context.role);
  const connectPath = `/api/workspaces/${workspaceId}/business-profiles/${businessProfileId}/channels/instagram/connect`;

  return (
    <div className="stack">
      <div className="page-header">
        <h1>{t.t("setup.channelsTitle")}</h1>
      </div>
      {message === undefined ? undefined : (
        <p className="notice" role="status" data-tone={outcome === "connected" ? undefined : "stop"}>
          {message}
        </p>
      )}
      <ChannelCards
        t={t}
        channels={facts.channels}
        offered={["INSTAGRAM"]}
        {...(canConfigure ? { instagramConnectPath: connectPath } : {})}
      />
    </div>
  );
}
