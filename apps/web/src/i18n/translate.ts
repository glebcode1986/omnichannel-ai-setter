/**
 * Turning a key into something a person reads (LOCALIZATION.md, Issue #58).
 *
 * A translator is built per request from the reader's resolved locale and carries nothing else, so a
 * component cannot accidentally render one locale's text with another's formatting.
 *
 * **Missing keys behave differently by environment, on purpose.** In development and test a missing key
 * throws: it is a bug, and the moment to find it is while the screen is being written. In production it
 * falls back to English and logs once — a person mid-task must not be shown a raw key or a blank space
 * because someone forgot a translation.
 *
 * All formatting goes through `Intl`. Plural categories come from `Intl.PluralRules` asking the locale,
 * never from comparing the number to 1: Russian has four categories and English has two, and code that
 * guessed would be wrong for "22 сообщения" in a way English never reveals.
 */
import { catalogues, pluralCatalogues, type MessageKey, type PluralKey } from "./catalogue";
import { FALLBACK_LOCALE, type UiLocale } from "./locales";

export interface Translator {
  readonly locale: UiLocale;
  /** One message, with `{name}` placeholders replaced. */
  t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string;
  /** A counted message, in the plural category this locale uses for this number. */
  plural: (key: PluralKey, count: number, values?: Readonly<Record<string, string | number>>) => string;
  /** A date, in a named timezone rather than the reader's, because it describes something elsewhere. */
  date: (value: Date, options?: Intl.DateTimeFormatOptions) => string;
  number: (value: number, options?: Intl.NumberFormatOptions) => string;
  money: (value: number, currency: string) => string;
  /**
   * A country, from its ISO 3166-1 alpha-2 code (#47).
   *
   * Through `Intl.DisplayNames` rather than catalogue keys, because the set of codes is open: a selling
   * entity can be registered anywhere, and a checkout that said "RO" would be showing a Russian reader a
   * code instead of a country. The code itself is returned when the platform has no name for it, which
   * is still readable and is what a reader would recognise from a form.
   */
  region: (code: string) => string;
}

/** Where a missing key is a bug to be thrown rather than a gap to be papered over. */
function shouldThrowOnMissing(): boolean {
  return process.env.NODE_ENV !== "production";
}

const reportedMisses = new Set<string>();

function reportMiss(locale: UiLocale, key: string, onMiss?: (message: string, fields: Record<string, string>) => void): void {
  const seen = `${locale}:${key}`;
  if (reportedMisses.has(seen)) {
    return;
  }
  reportedMisses.add(seen);
  onMiss?.("i18n.missing_key", { locale, key });
}

export interface TranslatorOptions {
  /** Called once per missing key, for the deployment's own logging. Never given the rendered text. */
  readonly onMiss?: (message: string, fields: Record<string, string>) => void;
}

export function createTranslator(locale: UiLocale, options: TranslatorOptions = {}): Translator {
  const catalogue = catalogues[locale];
  const fallback = catalogues[FALLBACK_LOCALE];
  const plurals = pluralCatalogues[locale];
  const pluralFallback = pluralCatalogues[FALLBACK_LOCALE];
  const pluralRules = new Intl.PluralRules(locale);

  const lookup = (key: string, own: Readonly<Record<string, string>>, english: Readonly<Record<string, string>>): string => {
    const value = own[key];
    if (value !== undefined) {
      return value;
    }
    if (shouldThrowOnMissing()) {
      throw new Error(`missing translation for "${key}" in locale "${locale}"`);
    }
    reportMiss(locale, key, options.onMiss);
    return english[key] ?? key;
  };

  return {
    locale,
    t: (key, values) => interpolate(lookup(key, catalogue, fallback), values),
    plural: (key, count, values) => {
      const forms = plurals[key] ?? pluralFallback[key];
      if (forms === undefined) {
        if (shouldThrowOnMissing()) {
          throw new Error(`missing plural translation for "${key}" in locale "${locale}"`);
        }
        reportMiss(locale, key, options.onMiss);
        return String(count);
      }
      // The locale decides which form applies; a locale without a `few` simply never asks for one.
      const category = pluralRules.select(count);
      const form = forms[category as keyof typeof forms] ?? forms.other;
      return interpolate(form, { ...values, count });
    },
    date: (value, dateOptions) => new Intl.DateTimeFormat(locale, dateOptions).format(value),
    number: (value, numberOptions) => new Intl.NumberFormat(locale, numberOptions).format(value),
    money: (value, currency) => new Intl.NumberFormat(locale, { style: "currency", currency }).format(value),
    region: (code) => {
      try {
        return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code;
      } catch {
        // `of` throws on anything that is not a well-formed region subtag. A CHECK refuses those on the
        // way in, so reaching this means a row older than the constraint — show the code rather than
        // taking a screen down over it.
        return code;
      }
    },
  };
}

/**
 * Replaces `{name}` placeholders.
 *
 * A placeholder with no value is left visible rather than blanked: "Next: {step}" is a bug someone will
 * notice and report, whereas "Next: " reads like an empty state and gets shipped.
 */
function interpolate(template: string, values?: Readonly<Record<string, string | number>>): string {
  if (values === undefined) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = values[name];
    return value === undefined ? whole : String(value);
  });
}
