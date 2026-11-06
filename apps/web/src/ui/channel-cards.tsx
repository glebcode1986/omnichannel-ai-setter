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
import { WhatsAppConnect } from "@/ui/channels/whatsapp-connect";

/**
 * How one channel's connection is started, because the two supported channels do not start the same way.
 *
 * `REDIRECT` is Instagram: a POST to our own route that answers `303` to Meta's authorize URL and sets
 * the state cookie on the same response, so a plain form takes the operator all the way there.
 *
 * `EMBEDDED` is WhatsApp: Meta's Embedded Signup (ADR-015) hands its result to *our page* through their
 * JavaScript SDK rather than through a redirect, so the route answers JSON and something in the browser
 * has to drive it.
 */
export type ConnectControl =
  | { readonly kind: "REDIRECT"; readonly action: string }
  | { readonly kind: "EMBEDDED"; readonly connectPath: string; readonly completePath: string };

export interface ChannelCardsProps {
  readonly t: Translator;
  readonly channels: readonly ChannelOnboardingFacts[];
  /** Channels this deployment can offer, so an unconnected one still gets a card to act on. */
  readonly offered: readonly ChannelType[];
  /**
   * How to connect each channel. A channel missing from here gets no control and says why: either this
   * reader may not connect channels, or the deployment has no app configured for it. A button that
   * answers 503 is worse than no button, because it reads as our fault rather than as a missing setup.
   */
  readonly connect?: Partial<Record<ChannelType, ConnectControl>>;
}

const readinessTones: Readonly<Record<string, "ok" | "warn" | "stop" | "muted">> = {
  NOT_CONFIGURED: "muted",
  CONFIGURED: "stop",
  CONNECTED: "warn",
  ELIGIBLE: "warn",
  SENDABLE: "ok",
};

export function ChannelCards({ t, channels, offered, connect = {} }: ChannelCardsProps) {
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
              {/*
                What this account cannot see, rather than what it cannot do. An account carrying a caveat
                is working normally, so it keeps its readiness badge and says the limitation separately
                (#23). An unconfigured channel has no account and therefore no caveats to state.
              */}
              {(account?.caveats ?? []).map((caveat) => (
                <p className="muted" data-caveat={caveat} key={caveat}>
                  {t.t(`channelCaveat.${caveat}` as MessageKey)}
                </p>
              ))}
              <ConnectAction t={t} channel={channel} readiness={readiness} control={connect[channel]} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The control that starts a connection, or the sentence that says why there is none.
 *
 * A **form**, not a link. The connect routes are `POST` only — both of them — and the Instagram card
 * had an `<a href>` pointing at one, so the button on the setup screen answered `405` and connected
 * nothing. A form is also the honest element: starting an OAuth flow writes a state row, which is not
 * something a link should do.
 */
function ConnectAction({
  t,
  channel,
  readiness,
  control,
}: {
  readonly t: Translator;
  readonly channel: ChannelType;
  readonly readiness: string;
  readonly control: ConnectControl | undefined;
}) {
  if (readiness === "SENDABLE") {
    return undefined;
  }
  if (control === undefined) {
    return (
      <p className="muted" data-no-control={channel}>
        {t.t("setup.channelNotOffered")}
      </p>
    );
  }
  if (control.kind === "EMBEDDED") {
    return (
      <WhatsAppConnect
        connectPath={control.connectPath}
        completePath={control.completePath}
        labels={{
          start: t.t("setup.connectWhatsApp"),
          working: t.t("setup.connectWorking"),
          connected: t.t("setup.connectConnected"),
          failed: t.t("setup.connectFailed"),
          notConfigured: t.t("setup.channelNotOffered"),
        }}
      />
    );
  }
  return (
    <form action={control.action} method="post">
      <button className="button" data-variant="primary" type="submit" data-connect={channel}>
        {t.t(`setup.connect${channel === "INSTAGRAM" ? "Instagram" : "WhatsApp"}` as MessageKey)}
      </button>
    </form>
  );
}
