/**
 * The channel connection surface.
 *
 * This is the route the Instagram callback already redirects to — `connectedRedirectUrl` in
 * `server/instagram.ts` builds exactly this path — so the page exists where the backend already expects
 * it rather than at a new address invented here. The `?instagram=` parameter it arrives with is the
 * outcome of the authorization attempt, and it is rendered as an actionable connection state rather than
 * a generic error.
 */
import { readOnboarding } from "@omnichannel/db";

import { ChannelCards } from "@/ui/channel-cards";
import { requestTranslator } from "@/i18n/request-locale";
import type { MessageKey } from "@/i18n/catalogue";
import { channelOffer } from "@/server/channel-offer";
import { getDb } from "@/server/db";
import { pageBusinessProfileContext } from "@/server/page-context";

/**
 * What the callback can report. Each has its own message, because "it failed" is not actionable.
 *
 * This must list *every* token the route can emit. Five of them were missing — `missing_scope`,
 * `already_connected`, `different_account`, `unavailable` and `error` — so the route redirected with a
 * reason and the page rendered nothing at all: the operator was returned to a screen that said their
 * connection attempt had simply not happened. Adding `not_entitled` beside them without fixing them would
 * have repeated it a sixth time, and `not_configured` is the eleventh for the same reason: the connect
 * route sends it when the deployment has no Instagram app, and a redirect nobody renders is silence.
 */
const CONNECT_OUTCOMES = [
  "connected",
  "denied",
  "expired",
  "invalid",
  "failed",
  "missing_scope",
  "already_connected",
  "different_account",
  "unavailable",
  "error",
  "not_entitled",
  "not_configured",
] as const;

export default async function ChannelsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly workspaceId: string; readonly businessProfileId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId, businessProfileId } = await params;
  const context = await pageBusinessProfileContext(workspaceId, businessProfileId);
  const { facts } = await readOnboarding(getDb(), context);
  const t = await requestTranslator();
  const outcome = (await searchParams).instagram;
  // Only outcomes this product knows about become messages: a query parameter is attacker-controlled, and
  // echoing an unknown one would be rendering a stranger's text inside the shell.
  const known = typeof outcome === "string" && (CONNECT_OUTCOMES as readonly string[]).includes(outcome) ? outcome : undefined;
  const message = known === undefined ? undefined : t.t(`connect.${known}` as MessageKey);

  // The same answer the setup screen gets. This page used to build its own, and passed it under a prop
  // `ChannelCards` had stopped declaring, so it drew no connect control at all on any deployment.
  const { offered, connect } = channelOffer({ workspaceId, businessProfileId }, context);

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
      <ChannelCards t={t} channels={facts.channels} offered={offered} connect={connect} />
    </div>
  );
}
