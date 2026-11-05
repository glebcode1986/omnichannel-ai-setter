// @vitest-environment jsdom
/**
 * The two choices a reader can make before they have an account.
 *
 * The cases worth writing are the ones where a control would lie about the state it is in, because that
 * is the whole job of a segmented control: a toggle that shows the wrong half is worse than no toggle,
 * and a reader cannot check it against anything.
 *
 * The one that needs saying out loud is the third theme state. `stored` is `undefined` when nobody has
 * chosen, and the server cannot resolve it — `prefers-color-scheme` never reaches a server. So the
 * control has to resolve it in the browser and keep following the system while no choice exists, and
 * that is asserted here against a stubbed `matchMedia` rather than assumed.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { catalogues } from "@/i18n/catalogue";
import { createTranslator } from "@/i18n/translate";
import { ThemeSwitch } from "@/ui/public/theme-switch";

const t = createTranslator("en");
const noop = () => Promise.resolve();

/** jsdom defines no `matchMedia`; the control reads one, so the test supplies the answer. */
function systemPrefersDark(dark: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    (query: string) => ({
      matches: dark && query.includes("dark"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  );
}

const options = [
  { value: "light" as const, label: t.t("publicSurface.themeLight"), action: noop },
  { value: "dark" as const, label: t.t("publicSurface.themeDark"), action: noop },
];

const pressed = () =>
  [...document.querySelectorAll("[data-public-theme]")]
    .filter((node) => node.getAttribute("aria-pressed") === "true")
    .map((node) => node.getAttribute("data-public-theme"));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the appearance control", () => {
  beforeEach(() => {
    systemPrefersDark(false);
  });

  const mount = (stored: "light" | "dark" | undefined) =>
    render(
      <ThemeSwitch
        groupLabel={t.t("publicSurface.theme")}
        stored={stored}
        options={options}
        cookieName="public_theme"
        cookieMaxAge={60}
      />,
    );

  it("offers both options rather than only the one not in use", () => {
    mount("dark");

    expect(screen.getByRole("button", { name: catalogues.en["publicSurface.themeLight"] })).toBeDefined();
    expect(screen.getByRole("button", { name: catalogues.en["publicSurface.themeDark"] })).toBeDefined();
  });

  it("marks exactly the stored choice", () => {
    mount("dark");

    expect(pressed()).toEqual(["dark"]);
  });

  it("marks the system's answer when nobody has chosen", () => {
    // The case the server cannot see. Without this the control shows light on a dark machine, which is
    // the one state a reader can prove wrong just by looking at the page behind it.
    systemPrefersDark(true);
    mount(undefined);

    expect(pressed()).toEqual(["dark"]);
  });

  it("marks light when nobody has chosen and the system prefers light", () => {
    // The control: the assertion above would also pass if the component simply always said "dark".
    systemPrefersDark(false);
    mount(undefined);

    expect(pressed()).toEqual(["light"]);
  });

  it("lets an explicit choice override the system rather than following it", () => {
    systemPrefersDark(true);
    mount("light");

    expect(pressed()).toEqual(["light"]);
  });

  it("names the group, so the two buttons are announced as one choice", () => {
    mount("light");

    expect(screen.getByRole("group", { name: catalogues.en["publicSurface.theme"] })).toBeDefined();
  });

  it("marks the stored choice in the markup the server sends, before any effect runs", () => {
    // Not the same claim as "marks exactly the stored choice" above, and a mutation proved it: dropping
    // the `useState` initialiser left that test green, because testing-library flushes effects before it
    // looks. The server never does. Rendering to static markup is the first paint — if the pressed state
    // is only set in an effect, the page arrives with neither option marked and then visibly corrects
    // itself, and the server and the client disagree about the HTML.
    const html = renderToStaticMarkup(
      <ThemeSwitch
        groupLabel={t.t("publicSurface.theme")}
        stored="dark"
        options={options}
        cookieName="public_theme"
        cookieMaxAge={60}
      />,
    );

    expect(html).toContain('data-public-theme="dark"');
    const dark = /<button[^>]*data-public-theme="dark"[^>]*>/u.exec(html)?.[0] ?? "";
    const light = /<button[^>]*data-public-theme="light"[^>]*>/u.exec(html)?.[0] ?? "";
    expect(dark, "the server must already mark the stored choice").toContain('aria-pressed="true"');
    expect(light, "and must not mark the other one").toContain('aria-pressed="false"');
  });

  it("submits a form for each option, so it works before the script does", () => {
    // Every option is a real form bound to a server action. With scripting off, or in the window before
    // hydration, clicking still sets the cookie — which is the only reason this is not a plain button.
    mount("light");

    for (const button of document.querySelectorAll("[data-public-theme]")) {
      expect(button.getAttribute("type")).toBe("submit");
      expect(button.closest("form"), "an option outside a form does nothing without JavaScript").not.toBeNull();
    }
  });
});
