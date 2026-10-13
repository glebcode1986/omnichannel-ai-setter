/**
 * Prices, as a person reads them (#42).
 *
 * One named function rather than a division at each call site, for two reasons that are both easy to get
 * wrong. `Translator.money` takes **major** units and every stored amount is **minor** ones, so
 * `t.money(4900, "EUR")` renders four thousand nine hundred euros — and nothing type-checks the mistake,
 * because both are numbers. And the exponent is not always two: a currency with no minor unit would be
 * divided by a hundred for no reason, so it is asked for rather than assumed.
 *
 * The currency comes from the row. `PRICING_PACKAGING.md` is explicit that the architecture stays
 * multi-currency, and a hardcoded `"EUR"` here would be the first place that stopped being true.
 */
import type { Translator } from "@/i18n/translate";

export function formatPrice(t: Translator, amountMinorUnits: number, currency: string): string {
  return t.money(amountMinorUnits / minorUnitsPerMajor(t.locale, currency), currency);
}

/**
 * How many minor units make one major one, as the reader's own locale data says.
 *
 * `Intl` knows this per currency; hardcoding a hundred would be right for most and silently wrong for
 * the rest. An unknown currency falls back to two, which is what `Intl` itself defaults to.
 */
function minorUnitsPerMajor(locale: string, currency: string): number {
  try {
    const digits = new Intl.NumberFormat(locale, { style: "currency", currency }).resolvedOptions().maximumFractionDigits;
    return 10 ** (digits ?? 2);
  } catch {
    // An unrecognised currency code reaches `Intl` as a throw. A price is still worth rendering, and the
    // formatter below will say what it can about it.
    return 100;
  }
}
