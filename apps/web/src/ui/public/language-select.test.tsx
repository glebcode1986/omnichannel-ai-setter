// @vitest-environment jsdom
/**
 * The language control, as a select.
 *
 * Two cases carry the weight. The first is that it applies on change, because there is no apply button
 * to fall back on when scripting is live — if the handler does not fire, the control looks finished and
 * does nothing. The second is the `<noscript>` button, which is the *only* way a reader without
 * scripting can change the language, and the one reader who most needs to: somebody who cannot read the
 * language the page is currently in.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { catalogues } from "@/i18n/catalogue";
import { localeNames, UI_LOCALES } from "@/i18n/locales";
import { createTranslator } from "@/i18n/translate";
import { LanguageSelect } from "@/ui/public/language-select";

const t = createTranslator("en");
const noop = (_formData: FormData) => Promise.resolve();
const options = UI_LOCALES.map((value) => ({ value, label: localeNames[value] }));

const control = (locale: "en" | "ru" = "en") => (
  <LanguageSelect
    label={t.t("publicSurface.language")}
    applyLabel={t.t("publicSurface.languageApply")}
    locale={locale}
    options={options}
    action={noop}
  />
);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the language control", () => {
  it("offers every language the product has, each named in its own language", () => {
    render(control());

    const select = screen.getByLabelText<HTMLSelectElement>(catalogues.en["publicSurface.language"]);
    expect([...select.options].map((option) => option.value)).toEqual([...UI_LOCALES]);
    // "Русский", not "Russian": a reader looking for their own language is looking for its own name.
    expect([...select.options].map((option) => option.textContent)).toEqual(UI_LOCALES.map((l) => localeNames[l]));
  });

  it("shows the language being read as the current one", () => {
    render(control("ru"));

    expect(screen.getByLabelText<HTMLSelectElement>(catalogues.en["publicSurface.language"]).value).toBe("ru");
  });

  it("applies on change, because there is no apply button when scripting works", () => {
    const requestSubmit = vi.fn();
    vi.spyOn(HTMLFormElement.prototype, "requestSubmit").mockImplementation(requestSubmit);
    render(control());

    const select = screen.getByLabelText(catalogues.en["publicSurface.language"]);
    expect(requestSubmit, "nothing should be submitted before the reader chooses").not.toHaveBeenCalled();

    fireEvent.change(select, { target: { value: "ru" } });

    expect(requestSubmit).toHaveBeenCalledTimes(1);
  });

  it("keeps a submit button for a reader with no scripting", () => {
    // Rendered as markup rather than in jsdom: jsdom has scripting, so it treats `<noscript>` content
    // as text and `getByRole` would never find the button. The question is what the *server sends*.
    const html = renderToStaticMarkup(control());

    expect(html).toContain("<noscript>");
    const noscript = html.slice(html.indexOf("<noscript>"), html.indexOf("</noscript>"));
    expect(noscript, "a reader who cannot read this page's language has no other way out").toContain('type="submit"');
    expect(noscript).toContain(catalogues.en["publicSurface.languageApply"]);
  });

  it("names itself, since the select carries no visible label", () => {
    const html = renderToStaticMarkup(control());

    expect(html).toContain(`aria-label="${catalogues.en["publicSurface.language"]}"`);
    // And the field is named, or the form would post nothing for the server to read.
    expect(html).toContain('name="locale"');
  });
});
