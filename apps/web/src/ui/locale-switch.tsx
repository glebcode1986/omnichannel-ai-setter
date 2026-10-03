/**
 * The interface-language control (Issue #58).
 *
 * A plain form with a labelled `<select>` and a submit button: it works without JavaScript, it is
 * reachable by keyboard, and the label is itself localized — an `aria-label` or a visible label left in
 * English is exactly as broken as a paragraph left in English, and less likely to be noticed.
 *
 * Each language is written in its own language, because someone looking for Russian is looking for
 * "Русский" and not for "Russian".
 */
import { localeNames, UI_LOCALES, type UiLocale } from "@/i18n/locales";
import type { Translator } from "@/i18n/translate";

export interface LocaleSwitchProps {
  readonly t: Translator;
  readonly current: UiLocale;
  readonly action: (formData: FormData) => void | Promise<void>;
}

export function LocaleSwitch({ t, current, action }: LocaleSwitchProps) {
  return (
    <form action={action} className="workspace-switch">
      <label htmlFor="ui-locale">{t.t("shell.localeLabel")}</label>
      <select id="ui-locale" name="locale" defaultValue={current}>
        {UI_LOCALES.map((locale) => (
          <option key={locale} value={locale}>
            {localeNames[locale]}
          </option>
        ))}
      </select>
      <button className="button" type="submit">
        {t.t("shell.localeSave")}
      </button>
    </form>
  );
}
