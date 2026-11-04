import Link from "next/link";

import { requestTranslator } from "@/i18n/request-locale";

/**
 * The product's front door, for somebody who has never heard of it.
 *
 * It used to be a title, one sentence and a button — a Phase 1 scaffold that said the product's name and
 * nothing a reader could decide anything from. The two screens a visitor could actually reach were this
 * one and a sign-in page reporting that no sign-in method is configured, so the only thing the product
 * said about itself in public was its own name.
 *
 * **Every claim here is one the code makes good on**, which is the whole constraint this page is written
 * under. Debouncing several messages into one thought, two separate libraries for facts and for tone,
 * the three modes, takeover cancelling a scheduled reply, the kill switch holding rather than discarding,
 * supersession withdrawing a reply the customer has overtaken, the randomized delay and the one-send
 * guarantee, the audit trail — each is a behaviour with a test, not a promise. Nothing is listed here
 * that a reader could sign up for and not find, and the beta's limits are stated rather than buried:
 * invitation-only, free, payments off.
 *
 * Built from the product's own design primitives — `shell-main`, `card-grid`, `card`, `button` — rather
 * than a separate marketing stylesheet, so the first screen a person sees already looks like the thing
 * they are about to use. Localized like every other surface; this is the most visible possible place to
 * leave untranslated English.
 */
export default async function HomePage() {
  const t = await requestTranslator();

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
    { key: "OFF", title: t.t("aiMode.OFF"), body: t.t("landing.modeOffBody") },
    { key: "DRAFT", title: t.t("aiMode.DRAFT"), body: t.t("landing.modeDraftBody") },
    { key: "AUTOPILOT", title: t.t("aiMode.AUTOPILOT"), body: t.t("landing.modeAutopilotBody") },
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
      <header className="landing-hero">
        <h1>{t.t("landing.title")}</h1>
        <p className="landing-lead">{t.t("landing.lead")}</p>
        <p className="landing-actions">
          <Link className="button" data-variant="primary" href="/sign-in">
            {t.t("landing.signIn")}
          </Link>
        </p>
        <p className="muted">{t.t("landing.status")}</p>
      </header>

      <section className="landing-section" aria-labelledby="landing-channels">
        <h2 id="landing-channels">{t.t("landing.channelsTitle")}</h2>
        <p className="muted">{t.t("landing.channelsLead")}</p>
        <ul className="card-grid landing-list">
          {channels.map((channel) => (
            <li className="card" key={channel.key}>
              <h3>{channel.title}</h3>
              <p className="muted">{channel.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="landing-section" aria-labelledby="landing-how">
        <h2 id="landing-how">{t.t("landing.howTitle")}</h2>
        <ol className="landing-steps">
          {steps.map((step) => (
            <li key={step.key}>
              <h3>{step.title}</h3>
              <p className="muted">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="landing-section" aria-labelledby="landing-modes">
        <h2 id="landing-modes">{t.t("landing.modesTitle")}</h2>
        <ul className="card-grid landing-list">
          {modes.map((mode) => (
            <li className="card" key={mode.key}>
              <h3>{mode.title}</h3>
              <p className="muted">{mode.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="landing-section" aria-labelledby="landing-control">
        <h2 id="landing-control">{t.t("landing.controlTitle")}</h2>
        <ul className="card-grid landing-list">
          {controls.map((control) => (
            <li className="card" key={control.key}>
              <h3>{control.title}</h3>
              <p className="muted">{control.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="landing-section" aria-labelledby="landing-inside">
        <h2 id="landing-inside">{t.t("landing.insideTitle")}</h2>
        <ul className="card-grid landing-list">
          {inside.map((area) => (
            <li className="card" key={area.key}>
              <h3>{area.title}</h3>
              <p className="muted">{area.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="landing-section landing-closing" aria-labelledby="landing-closing">
        <h2 id="landing-closing">{t.t("landing.closingTitle")}</h2>
        <p className="muted">{t.t("landing.closingBody")}</p>
        <p className="landing-actions">
          <Link className="button" data-variant="primary" href="/sign-in">
            {t.t("landing.signIn")}
          </Link>
        </p>
      </section>
    </main>
  );
}
