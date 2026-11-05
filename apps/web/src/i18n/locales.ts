/**
 * The product's UI locales (LOCALIZATION.md, Issue #58).
 *
 * English is the **fallback**, not the default preference. Someone who chose Russian and meets an
 * untranslated string sees English: degraded, but readable and actionable. Showing them a raw key, or
 * nothing, would be worse than showing them the wrong language.
 *
 * Nothing here touches the language the assistant replies to customers in. That lives on the Business
 * Profile's style profile, and the two are kept structurally apart on purpose — see the spec.
 */
import { canonicalLanguageTag } from "@omnichannel/domain";

export const UI_LOCALES = ["en", "ru"] as const;
export type UiLocale = (typeof UI_LOCALES)[number];

/** What a person sees when their own locale has nothing to say. */
export const FALLBACK_LOCALE: UiLocale = "en";

export const localeNames: Readonly<Record<UiLocale, string>> = {
  // Each in its own language: a person looking for Russian is looking for "Русский".
  en: "English",
  ru: "Русский",
};

/**
 * The two-letter badge a compact control shows.
 *
 * Here rather than in the catalogue because it is not a translation: `EN` is `EN` in both catalogues, and
 * a key whose two values are identical has to be argued for in `translate.test.ts`'s allowlist. A
 * language's own code is an identifier, like the platform names already listed there — so it is declared
 * as data next to the names it abbreviates, where the two cannot disagree about which locales exist.
 *
 * Never the accessible name on its own: `RU` read aloud is two letters, so the control labels itself with
 * `localeNames` and shows this.
 */
export const localeShortNames: Readonly<Record<UiLocale, string>> = {
  en: "EN",
  ru: "RU",
};

/**
 * The stored preference, resolved to a locale this product actually has.
 *
 * Canonicalized through the domain's own tag handling, so `RU`, `ru` and `ru-RU` cannot become three
 * different preferences. A regional variant resolves to its base language rather than being refused:
 * `ru-KZ` is a Russian reader, and telling them the product has no Russian would be wrong.
 */
export function resolveUiLocale(stored: string | null | undefined): UiLocale {
  const canonical = canonicalLanguageTag(stored ?? undefined);
  if (canonical === undefined || canonical === null) {
    return FALLBACK_LOCALE;
  }
  const base = canonical.split("-")[0]?.toLowerCase() ?? "";
  return isUiLocale(base) ? base : FALLBACK_LOCALE;
}

export function isUiLocale(value: unknown): value is UiLocale {
  return typeof value === "string" && (UI_LOCALES as readonly string[]).includes(value);
}
