/**
 * Channel connection cards (ONBOARDING_UX.md).
 *
 * Each card says how far one channel got, using the four states the spec refuses to let the product
 * conflate. The readiness itself is computed in the domain; this decides only how to say it.
 *
 * Nothing here receives a credential, which is the point: "no production secret is displayed after secure
 * storage" is easiest to guarantee when the component is never handed one. The props carry a provider
 * account identifier and a status, and nothing else.
 */
import {
  channelReadiness,
  type ChannelOnboardingFacts,
  type ChannelType,
} from "@omnichannel/domain";

import {
  channelLabels,
  channelReadinessExplanations,
  channelReadinessLabels,
  channelReadinessTones,
  setupText,
} from "./labels";

export interface ChannelCardsProps {
  readonly channels: readonly ChannelOnboardingFacts[];
  /** Channels this deployment can offer, so an unconnected one still gets a card to act on. */
  readonly offered: readonly ChannelType[];
  /** Where the Instagram connect flow starts; omitted when the viewer may not connect channels. */
  readonly instagramConnectPath?: string;
}

export function ChannelCards({ channels, offered, instagramConnectPath }: ChannelCardsProps) {
  return (
    <section aria-labelledby="channels-heading" className="stack">
      <h2 id="channels-heading">{setupText.channelsTitle}</h2>
      {channels.length === 0 ? <p className="muted">{setupText.noChannels}</p> : undefined}
      <ul className="card-grid" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {offered.map((channel) => {
          const account = channels.find((candidate) => candidate.channel === channel);
          const readiness = account === undefined ? "NOT_CONFIGURED" : channelReadiness(account);
          return (
            <li className="card" key={channel}>
              <h3>{channelLabels[channel] ?? channel}</h3>
              <p>
                <span className="badge" data-tone={channelReadinessTones[readiness]}>
                  {channelReadinessLabels[readiness]}
                </span>
              </p>
              <p className="muted">{channelReadinessExplanations[readiness]}</p>
              {channel === "INSTAGRAM" && instagramConnectPath !== undefined && readiness !== "SENDABLE" ? (
                // A link rather than a form: the connect route starts an OAuth redirect, and it is the
                // existing onboarding backend rather than a second one invented here.
                <a className="button" data-variant="primary" href={instagramConnectPath}>
                  {setupText.connectInstagram}
                </a>
              ) : undefined}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
