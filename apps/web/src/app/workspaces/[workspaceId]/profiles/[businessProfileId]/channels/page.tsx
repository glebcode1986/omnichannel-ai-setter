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
import { setupText } from "@/ui/labels";
import { getDb } from "@/server/db";
import { requireBusinessProfileContext } from "@/server/request-context";

/** What the callback can report, mapped to something a person can act on. */
const connectOutcomes: Readonly<Record<string, string>> = {
  connected: "Instagram is connected.",
  denied: "The authorization was declined, so nothing changed.",
  expired: "That connection attempt timed out. Start it again.",
  invalid: "That connection attempt could not be verified. Start it again.",
  failed: "Instagram could not complete the connection. Start it again.",
};

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
  const outcome = (await searchParams).instagram;
  const message = typeof outcome === "string" ? connectOutcomes[outcome] : undefined;

  const canConfigure = WORKSPACE_ADMIN_ROLES.includes(context.role);
  const connectPath = `/api/workspaces/${workspaceId}/business-profiles/${businessProfileId}/channels/instagram/connect`;

  return (
    <div className="stack">
      <div className="page-header">
        <h1>{setupText.channelsTitle}</h1>
      </div>
      {message === undefined ? undefined : (
        <p className="notice" role="status" data-tone={outcome === "connected" ? undefined : "stop"}>
          {message}
        </p>
      )}
      <ChannelCards
        channels={facts.channels}
        offered={["INSTAGRAM"]}
        {...(canConfigure ? { instagramConnectPath: connectPath } : {})}
      />
    </div>
  );
}
