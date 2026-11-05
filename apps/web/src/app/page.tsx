import { cookies } from "next/headers";
import Link from "next/link";

import { createTranslator } from "@/i18n/translate";
import { publicLocaleOf, PUBLIC_LOCALE_COOKIE } from "@/server/public-locale";
import { publicThemeOf, PUBLIC_THEME_COOKIE } from "@/server/public-theme";
import { CancelWindow } from "@/ui/landing/cancel-window";
import { Mark } from "@/ui/landing/mark";
import { SurfaceControls } from "@/ui/public/surface-controls";

/**
 * The product's front door, for somebody who has never heard of it.
 *
 * It used to be a title, one sentence and a button — a Phase 1 scaffold. The only other page a visitor
 * could reach reports that no sign-in method is configured, so in public the product said its own name
 * and stopped, while twenty-five screens of it sat behind a door nobody was told about.
 *
 * **Every claim here is a behaviour with a test behind it**, which is the constraint the page is written
 * under: several messages waited out and read as one thought, two separate libraries for facts and for
 * tone, the three modes, takeover cancelling a reply already scheduled, the kill switch holding work
 * rather than discarding it, a reply withdrawn when the customer overtakes it, the uneven delay and the
 * one-send guarantee, and the audit of drafts, decisions and sends. Nothing is listed that a reader could
 * sign up for and not find, and the beta's limits are stated at the top rather than buried at the bottom.
 *
 * Its own type scale and bands, unlike every other screen. The product's shell is deliberately dense
 * because it is read all day; a first screen is read once, by somebody deciding whether to bother. What
 * it does *not* get is its own colours: both bands are tokens on `:root`, so `a11y/contrast.test.ts` can
 * compute them in each theme — a band written inline here would be invisible to that gate. Nothing is set
 * over the hero's glow for the same reason: contrast over a gradient is the one thing the gate admits it
 * cannot judge, so no text relies on it.
 *
 * The flow illustration is `aria-hidden` and carries no information of its own: it stages the same four
 * steps the ordered list below states in words, so a reader using a screen reader loses nothing, and it
 * is built from the product's real primitives rather than being a screenshot or a mock-up of one.
 */
export default async function HomePage() {
  // The public surface's own language choice, the same one `sign-in/page.tsx` reads, and for the reason
  // its comment gives: `requestTranslator()` resolves a *signed-in* user's stored preference and falls
  // back to English, which is right for a page behind the door and wrong for the one in front of it.
  // Using it here meant a reader who had already picked Russian on sign-in came back to an English
  // landing page — the two most public screens in the product disagreeing about their own language.
  const store = await cookies();
  const locale = publicLocaleOf(store.get(PUBLIC_LOCALE_COOKIE)?.value);
  const theme = publicThemeOf(store.get(PUBLIC_THEME_COOKIE)?.value);
  const t = createTranslator(locale);

  const channels = [
    { key: "instagram", title: t.t("landing.channelInstagram"), body: t.t("landing.channelInstagramBody") },
    { key: "whatsapp", title: t.t("landing.channelWhatsApp"), body: t.t("landing.channelWhatsAppBody") },
  ];

  const steps = [
    { key: "1", title: t.t("landing.howStep1"), body: t.t("landing.howStep1Body") },
    { key: "2", title: t.t("landing.howStep2"), body: t.t("landing.howStep2Body") },
    { key: "3", title: t.t("landing.howStep3"), body: t.t("landing.howStep3Body") },
    { key: "4", title: t.t("landing.howStep4"), body: t.t("landing.howStep4Body") },
  ];

  const modes = [
    { key: "OFF", title: t.t("aiMode.OFF"), body: t.t("landing.modeOffBody"), featured: false },
    // Highlighted because it is where a pilot starts, which the body text says in words as well.
    { key: "DRAFT", title: t.t("aiMode.DRAFT"), body: t.t("landing.modeDraftBody"), featured: true },
    { key: "AUTOPILOT", title: t.t("aiMode.AUTOPILOT"), body: t.t("landing.modeAutopilotBody"), featured: false },
  ];

  const controls = [
    { key: "1", title: t.t("landing.control1"), body: t.t("landing.control1Body") },
    { key: "2", title: t.t("landing.control2"), body: t.t("landing.control2Body") },
    { key: "3", title: t.t("landing.control3"), body: t.t("landing.control3Body") },
    { key: "4", title: t.t("landing.control4"), body: t.t("landing.control4Body") },
  ];

  const inside = [
    { key: "inbox", title: t.t("nav.inbox"), body: t.t("landing.insideInbox") },
    { key: "review", title: t.t("nav.review"), body: t.t("landing.insideReview") },
    { key: "leads", title: t.t("nav.leads"), body: t.t("landing.insideLeads") },
    { key: "knowledge", title: t.t("nav.knowledge"), body: t.t("landing.insideKnowledge") },
    { key: "style", title: t.t("nav.style"), body: t.t("landing.insideStyle") },
    { key: "analytics", title: t.t("nav.analytics"), body: t.t("landing.insideAnalytics") },
    { key: "settings", title: t.t("nav.settings"), body: t.t("landing.insideSettings") },
  ];

  return (
    <main className="shell-main landing">
      <section className="landing-band" data-tone="hero">
        <div className="landing-glow" aria-hidden="true" />
        {/* Above the hero rather than in it: the controls belong to the whole surface, not to the
            headline, and a direct child of the band inherits the band's rail so they line up with
            everything below them. */}
        <div className="landing-topbar">
          <SurfaceControls t={t} locale={locale} theme={theme} path="/" />
        </div>
        <div className="landing-hero-inner">
          <div>
            {/* The mark and the word together. The mark carries the label, so the name is announced
                once rather than twice to a screen reader. */}
            <p className="landing-wordmark">
              <Mark title={t.t("landing.title")} className="landing-logo" />
              <span>{t.t("landing.title")}</span>
            </p>
            {/* A headline, not a paragraph. The first version put the full promise in the `h1` and it set
                eight lines of 60px type — 509 pixels of heading before a reader reached anything else.
                The promise is still here; it moved one element down, where a sentence belongs. */}
            <h1>{t.t("landing.headline")}</h1>
            <p className="landing-lead">{t.t("landing.lead")}</p>
            <p className="landing-actions">
              <Link className="button" data-variant="primary" href="/sign-in">
                {t.t("landing.signIn")}
              </Link>
              <Link className="button" href="#how">
                {t.t("landing.howItWorks")}
              </Link>
            </p>
            <p className="landing-note">{t.t("landing.status")}</p>
          </div>

          <CancelWindow
            copy={{
              customerLabel: t.t("landing.figureCustomerLabel"),
              customerText: t.t("landing.figureCustomerText"),
              draftLabel: t.t("landing.figureDraftLabel"),
              draftText: t.t("landing.figureDraftText"),
              why: t.t("landing.figureWhy"),
              typing: t.t("landing.demoTyping"),
              // One sentence per second the countdown can show, interpolated here because the component
              // cannot be handed a translator: functions do not cross the server/client boundary.
              waiting: Array.from({ length: 11 }, (_unused, seconds) => t.t("landing.demoWaiting", { seconds })),
              cancel: t.t("landing.demoCancel"),
              sent: t.t("landing.demoSent"),
              cancelled: t.t("landing.demoCancelled"),
              replay: t.t("landing.demoReplay"),
              hint: t.t("landing.demoHint"),
              region: t.t("landing.demoRegion"),
            }}
          />
        </div>
      </section>

      <section className="landing-band" aria-labelledby="landing-channels">
        <h2 id="landing-channels">{t.t("landing.channelsTitle")}</h2>
        <ul className="landing-grid">
          {channels.map((channel) => (
            <li key={channel.key}>
              <h3>{channel.title}</h3>
              <p>{channel.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="landing-band" data-tone="alt" id="how" aria-labelledby="landing-how">
        <h2 id="landing-how">{t.t("landing.howTitle")}</h2>
        <ol className="landing-steps">
          {steps.map((step) => (
            <li key={step.key}>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="landing-band" aria-labelledby="landing-modes">
        <h2 id="landing-modes">{t.t("landing.modesTitle")}</h2>
        <ul className="landing-grid">
          {modes.map((mode) => (
            <li key={mode.key} data-featured={mode.featured ? "true" : undefined}>
              <h3>{mode.title}</h3>
              <p>{mode.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="landing-band" data-tone="alt" aria-labelledby="landing-control">
        <h2 id="landing-control">{t.t("landing.controlTitle")}</h2>
        <ul className="landing-grid">
          {controls.map((control) => (
            <li key={control.key}>
              <h3>{control.title}</h3>
              <p>{control.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="landing-band" aria-labelledby="landing-inside">
        <h2 id="landing-inside">{t.t("landing.insideTitle")}</h2>
        <ul className="landing-grid">
          {inside.map((area) => (
            <li key={area.key}>
              <h3>{area.title}</h3>
              <p>{area.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="landing-band landing-closing" data-tone="alt" aria-labelledby="landing-closing">
        <h2 id="landing-closing">{t.t("landing.closingTitle")}</h2>
        <p className="landing-sub">{t.t("landing.closingBody")}</p>
        <p className="landing-actions">
          <Link className="button" data-variant="primary" href="/sign-in">
            {t.t("landing.signIn")}
          </Link>
        </p>
      </section>

      {/* The legal documents, at the bottom where a reader looks for them. A `nav` rather than a bare row
          of links: it is a named group, and somebody using a screen reader's landmark list should find it
          there instead of hunting through the closing section. */}
      <footer className="landing-footer">
        <nav aria-label={t.t("legal.footerLabel")}>
          <Link href="/privacy">{t.t("legal.privacyTitle")}</Link>
          <Link href="/terms">{t.t("legal.termsTitle")}</Link>
        </nav>
        <p>{t.t("landing.status")}</p>
      </footer>
    </main>
  );
}
