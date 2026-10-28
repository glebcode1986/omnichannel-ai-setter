/**
 * The one-time sign-in link, as a message (#117, ADR-022).
 *
 * Pure: a locale, a URL and an expiry in, a subject and two bodies out. No transport, no environment and
 * no database, so the wording can be tested — which matters more here than in most places, because two
 * of the rules this message has to keep are rules about what it must **not** say.
 *
 * **It never reveals whether the address has an account.** The same message goes to somebody registering
 * and somebody returning, and it is addressed to the *request* rather than to a person: "you asked to
 * sign in". A mail that said "welcome back" would turn the sign-in form into an oracle for whether any
 * address is a customer here, answerable by anybody, one address at a time.
 *
 * **It never carries a secret beyond the link itself.** The link is the credential for one click; the
 * message adds nothing else, names no workspace, and says nothing about what the account can see.
 */
import { catalogues, type MessageKey } from "@/i18n/catalogue";
import type { UiLocale } from "@/i18n/locales";
import { createTranslator } from "@/i18n/translate";

export interface SignInEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/** Minimal escaping for the one value interpolated into HTML. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Builds the message in the locale the person was reading when they asked.
 *
 * The locale is passed in rather than read from a session, because there is no session: whoever is asking
 * for this link is by definition not signed in. The public sign-in page carries its own language choice
 * into the request, so the message matches the page it came from.
 */
export function signInEmail(locale: UiLocale, url: string, expires: Date): SignInEmail {
  const t = createTranslator(locale);
  const key = (name: string): MessageKey => `signInEmail.${name}` as MessageKey;
  const when = t.date(expires, { dateStyle: "medium", timeStyle: "short" });

  const subject = t.t(key("subject"));
  const lines = [t.t(key("intro")), "", url, "", t.t(key("expires"), { when }), "", t.t(key("ignore"))];
  const safeUrl = escapeHtml(url);
  const html = [
    `<p>${escapeHtml(t.t(key("intro")))}</p>`,
    `<p><a href="${safeUrl}">${escapeHtml(t.t(key("action")))}</a></p>`,
    `<p>${escapeHtml(t.t(key("expires"), { when }))}</p>`,
    `<p>${escapeHtml(t.t(key("ignore")))}</p>`,
  ].join("\n");

  return { subject, text: lines.join("\n"), html };
}

/** The locales this message exists in, read from the catalogues rather than restated. */
export function signInEmailLocales(): readonly UiLocale[] {
  return Object.keys(catalogues) as readonly UiLocale[];
}
