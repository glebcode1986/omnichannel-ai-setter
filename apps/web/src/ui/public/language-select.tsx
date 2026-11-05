"use client";

/**
 * The language control, as a select.
 *
 * It was a row of buttons, one per language, which is a fine control for two and stops being a control
 * somewhere around the fifth — it becomes a paragraph the header has to find room for. The product is
 * meant to gain languages, so the shape has to survive that: a select is the same size at twenty as at
 * two, and it arrives with keyboard handling, type-to-search, and a platform-native overlay on a phone
 * that no hand-built menu matches.
 *
 * Submitting on change is the whole interaction — there is no "apply" step to forget — and `requestSubmit`
 * is used rather than `submit()` because only the former runs validation and fires the submit event the
 * server action is attached to.
 *
 * Without scripting the change handler never runs, so the form keeps a submit button inside `<noscript>`.
 * That is not a formality: this is a public page and the language control is how a reader who cannot read
 * the current language escapes it. A control that silently does nothing would strand exactly the person
 * it exists for.
 */
import { useRef } from "react";

import type { UiLocale } from "@/i18n/locales";

export interface LanguageOption {
  readonly value: UiLocale;
  /** The language's own name — somebody looking for Russian is looking for "Русский". */
  readonly label: string;
}

export interface LanguageSelectProps {
  readonly label: string;
  readonly applyLabel: string;
  readonly locale: UiLocale;
  readonly options: readonly LanguageOption[];
  /** `choosePublicLocaleAction` bound to the page's own path; it reads `locale` from the form. */
  readonly action: (formData: FormData) => Promise<void>;
}

export function LanguageSelect({ label, applyLabel, locale, options, action }: LanguageSelectProps) {
  const form = useRef<HTMLFormElement>(null);

  return (
    <form action={action} className="switch switch-field" ref={form}>
      <select
        className="switch-select"
        name="locale"
        aria-label={label}
        defaultValue={locale}
        data-public-locale-select="true"
        onChange={() => {
          form.current?.requestSubmit();
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <noscript>
        <button className="switch-option" type="submit">
          {applyLabel}
        </button>
      </noscript>
    </form>
  );
}
