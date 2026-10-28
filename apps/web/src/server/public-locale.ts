/**
 * The language of somebody who is not signed in yet (#117).
 *
 * `requestLocale` reads the signed-in user's own stored preference and falls back to English, and its
 * comment says why that is right: "Sign-in and error screens have to be readable, and falling back is the
 * right answer rather than a reason to fail." That rule is left exactly as it is. But a *public* sign-in
 * page has no user to read a preference from, and a Russian-speaking customer registering for the first
 * time should not be made to read English and then receive an English link.
 *
 * So the public surface carries its own explicit choice, in a cookie the page's own language control sets.
 * Explicit rather than sniffed: `Accept-Language` is a guess about a person made by whatever they happen
 * to be browsing with, and choosing a product's language from a header is a product decision nobody has
 * made here. Nothing authenticated reads this — `users.uiLocale` stays the only preference above the
 * sign-in line — and the cookie is replaced by that preference the moment somebody signs in.
 */
import { FALLBACK_LOCALE, isUiLocale, type UiLocale } from "@/i18n/locales";

/** Named for what it is: the language chosen on the public sign-in surface, and nothing wider. */
export const PUBLIC_LOCALE_COOKIE = "signin_locale";

/**
 * The chosen locale, from the cookie's value as Next's `cookies()` already parsed it.
 *
 * Anything unrecognised is the fallback. A cookie is attacker-settable, and the worst a hostile value can
 * do here is pick between two catalogues — so it is validated against the locales that exist and is never
 * used for anything else.
 */
export function publicLocaleOf(value: string | null | undefined): UiLocale {
  return value !== null && value !== undefined && isUiLocale(value) ? value : FALLBACK_LOCALE;
}

/**
 * The same answer from a raw `Cookie` header, for the mailer.
 *
 * Two entry points because the two callers hold different things: a page has Next's parsed cookie store,
 * and `sendVerificationRequest` is handed a whole `Request`. Both end at `publicLocaleOf`, so the page and
 * the message cannot disagree about which language was chosen.
 */
export function publicLocaleFrom(cookieHeader: string | null | undefined): UiLocale {
  if (cookieHeader === null || cookieHeader === undefined || cookieHeader === "") {
    return FALLBACK_LOCALE;
  }
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) {
      continue;
    }
    if (part.slice(0, separator).trim() !== PUBLIC_LOCALE_COOKIE) {
      continue;
    }
    return publicLocaleOf(decodeURIComponent(part.slice(separator + 1).trim()));
  }
  return FALLBACK_LOCALE;
}
