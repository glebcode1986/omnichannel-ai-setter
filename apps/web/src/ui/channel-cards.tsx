/**
 * Channel connection cards (ONBOARDING_UX.md).
 *
 * Each card says how far one channel got, using the four states the spec refuses to let the product
 * conflate. The readiness itself is computed in the domain; this decides only how to say it, and the
 * saying is done by the catalogue.
 *
 * Nothing here receives a credential, which is the point: "no production secret is displayed after secure
 * storage" is easiest to guarantee when the component is never handed one. The props carry a channel, a
 * status and a readiness, and nothing else.
 */
import { channelReadiness, type ChannelOnboardingFacts, type ChannelType } from "@omnichannel/domain";

import type { Translator } from "@/i18n/translate";
import type { MessageKey } from "@/i18n/catalogue";

export interface ChannelCardsProps {
  readonly t: Translator;
  readonly channels: readonly ChannelOnboardingFacts[];
  /** Channels this deployment can offer, so an unconnected one still gets a card to act on. */
  readonly offered: readonly ChannelType[];
  /** Where the Instagram connect flow starts; omitted when the viewer may not connect channels. */
  readonly instagramConnectPath?: string;
}

const readinessTones: Readonly<Record<string, "ok" | "warn" | "stop" | "muted">> = {
  NOT_CONFIGURED: "muted",
  CONFIGURED: "stop",
  CONNECTED: "warn",
  ELIGIBLE: "warn",
  SENDABLE: "ok",
};

export function ChannelCards({ t, channels, offered, instagramConnectPath }: ChannelCardsProps) {
  return (
    <section aria-labelledby="channels-heading" className="stack">
      <h2 id="channels-heading">{t.t("setup.channelsTitle")}</h2>
      {channels.length === 0 ? <p className="muted">{t.t("setup.noChannels")}</p> : undefined}
      <ul className="card-grid" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {offered.map((channel) => {
          const account = channels.find((candidate) => candidate.channel === channel);
          const readiness = account === undefined ? "NOT_CONFIGURED" : channelReadiness(account);
          return (
            <li className="card" key={channel}>
              <h3>{t.t(`channel.${channel}` as MessageKey)}</h3>
              <p>
                <span className="badge" data-tone={readinessTones[readiness]} data-readiness={readiness}>
                  {t.t(`channelReadiness.${readiness}` as MessageKey)}
                </span>
              </p>
              <p className="muted">{t.t(`channelReadinessDetail.${readiness}` as MessageKey)}</p>
              {channel === "INSTAGRAM" && instagramConnectPath !== undefined && readiness !== "SENDABLE" ? (
                // A link rather than a form: the connect route starts an OAuth redirect, and it is the
                // existing onboarding backend rather than a second one invented here.
                <a className="button" data-variant="primary" href={instagramConnectPath}>
                  {t.t("setup.connectInstagram")}
                </a>
              ) : undefined}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
