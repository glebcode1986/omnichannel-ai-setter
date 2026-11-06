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
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  it("offers every language the product has, each named in its own language", async () => {
    const user = userEvent.setup();
    render(control());

    await user.click(screen.getByRole("combobox", { name: catalogues.en["publicSurface.language"] }));

    // "Русский", not "Russian": a reader looking for their own language is looking for its own name.
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(UI_LOCALES.map((l) => localeNames[l]));
  });

  it("shows the language being read as the current one", () => {
    render(control("ru"));

    expect(screen.getByRole("combobox", { name: catalogues.en["publicSurface.language"] }).textContent).toContain(localeNames.ru);
    // And the form would post it, which is the half a visible label cannot show.
    expect(document.querySelector<HTMLInputElement>('input[name="locale"]')?.value).toBe("ru");
  });

  it("applies on change, because there is no apply button when scripting works", async () => {
    const user = userEvent.setup();
    const requestSubmit = vi.fn();
    vi.spyOn(HTMLFormElement.prototype, "requestSubmit").mockImplementation(requestSubmit);
    render(control());

    await user.click(screen.getByRole("combobox", { name: catalogues.en["publicSurface.language"] }));
    expect(requestSubmit, "nothing should be submitted before the reader chooses").not.toHaveBeenCalled();

    await user.click(screen.getByRole("option", { name: localeNames.ru }));

    expect(requestSubmit).toHaveBeenCalledTimes(1);
    expect(document.querySelector<HTMLInputElement>('input[name="locale"]')?.value).toBe("ru");
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

  it("names itself, since the control carries no visible label", () => {
    // The server render, which is also what a reader with no scripting gets: a real select.
    const html = renderToStaticMarkup(control());

    expect(html).toContain(`aria-label="${catalogues.en["publicSurface.language"]}"`);
    // And the field is named, or the form would post nothing for the server to read.
    expect(html).toContain('name="locale"');
    expect(html, "the control that ships without scripting is the native one").toContain("<select");
  });
});


describe("the control after the language has changed", () => {
  it("shows the language that is stored, not the one it was first rendered with", () => {
    // The defect this exists for, measured on dev before it was fixed: switching to Russian gave a
    // Russian heading, `lang="ru"` and `ru` in the database, and left this control reading "English".
    // `defaultValue` on an uncontrolled select is read at mount, so a re-render with a new preference
    // reconciles the same element and keeps the selection the DOM already had. Re-rendering is exactly
    // what the server action causes, so the two disagreed every time somebody used the control.
    const options = [
      { value: "en" as const, label: "English" },
      { value: "ru" as const, label: "Русский" },
    ];
    const view = render(<LanguageSelect label="Interface language" applyLabel="Save" locale="en" options={options} action={vi.fn()} />);
    expect(screen.getByRole("combobox", { name: "Interface language" }).textContent).toContain("English");

    // The same tree, re-rendered with what the action stored — which is what the layout does.
    view.rerender(<LanguageSelect label="Interface language" applyLabel="Save" locale="ru" options={options} action={vi.fn()} />);

    expect(screen.getByRole("combobox", { name: "Interface language" }).textContent).toContain("Русский");
    expect(document.querySelector<HTMLInputElement>('input[name="locale"]')?.value).toBe("ru");
  });
});
