// @vitest-environment jsdom
/**
 * The public sign-in surface (#117).
 *
 * The cases worth writing are the ones where this page would offer something the server will refuse, or
 * say something untrue to somebody who cannot sign in: a button for a method that is withheld, a blank
 * form where a method is misconfigured, and the `OAuthAccountNotLinked` refusal — which, with two methods
 * on one address, is the most likely failure in the whole flow and lands on *this* page rather than an
 * error page.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SignInPanel } from "./sign-in-panel";
import { catalogues, type MessageKey } from "@/i18n/catalogue";
import { createTranslator } from "@/i18n/translate";
import type { SignInMethod } from "@/server/sign-in-methods";

const t = createTranslator("en");
const ru = createTranslator("ru");
const text = (key: MessageKey) => catalogues.en[key];
const noop = () => Promise.resolve();
const noopWithForm = (_formData: FormData) => Promise.resolve();
const noopWithLocale = (_locale: string) => Promise.resolve();

afterEach(cleanup);

const panel = (available: readonly SignInMethod[], error?: string) => (
  <SignInPanel
    t={t}
    locale="en"
    available={available}
    error={error}
    googleAction={noop}
    emailAction={noopWithForm}
    languageAction={noopWithLocale}
  />
);

describe("what the sign-in page offers", () => {
  it("offers both methods when both are available", () => {
    render(panel(["google", "email"]));

    expect(screen.getByRole("button", { name: text("signIn.google") })).toBeDefined();
    expect(screen.getByLabelText(text("signIn.emailLabel"))).toBeDefined();
    expect(screen.getByRole("button", { name: text("signIn.emailSubmit") })).toBeDefined();
  });

  it("offers only what is available, and not a control the server would refuse", () => {
    // The rule the whole module is arranged around: the page renders from the same answer `auth.ts`
    // builds its providers from, so a withheld method is absent from both.
    render(panel(["email"]));
    expect(screen.queryByRole("button", { name: text("signIn.google") })).toBeNull();
    cleanup();

    render(panel(["google"]));
    expect(screen.queryByLabelText(text("signIn.emailLabel"))).toBeNull();
  });

  it("says sign-in is not configured instead of rendering a form that cannot work", () => {
    render(panel([]));

    expect(screen.getByText(text("signIn.unavailableBody"))).toBeDefined();
    expect(document.querySelector('[data-sign-in="google"]')).toBeNull();
    expect(document.querySelector('[data-sign-in="email"]')).toBeNull();
    // And the heading says so too, rather than inviting somebody to sign in.
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(text("signIn.unavailableTitle"));
  });

  it("explains the refusal that two methods on one address actually produce", () => {
    render(panel(["google", "email"], "OAuthAccountNotLinked"));

    expect(screen.getByText(text("signIn.errorNotLinked"))).toBeDefined();
    expect(document.querySelector("[data-sign-in-notice]")?.getAttribute("data-sign-in-notice")).toBe("NOT_LINKED");
  });

  it.each([
    ["Verification", "signIn.errorLinkExpired"],
    ["AccessDenied", "signIn.errorAccessDenied"],
    ["EmailRequired", "signIn.errorEmailRequired"],
    ["Configuration", "signIn.errorGeneric"],
    ["SomethingNobodyEmits", "signIn.errorGeneric"],
  ])("renders a sentence for %s", (error, key) => {
    render(panel(["google", "email"], error));

    expect(screen.getByText(text(key as MessageKey))).toBeDefined();
  });

  it("shows no notice when nothing has gone wrong", () => {
    render(panel(["google", "email"]));

    expect(document.querySelector("[data-sign-in-notice]")).toBeNull();
  });

  it("announces a refusal rather than only showing it", () => {
    render(panel(["google", "email"], "Verification"));

    expect(screen.getByRole("status").textContent).toBe(text("signIn.errorLinkExpired"));
  });

  it("offers the other language, named in that language", () => {
    render(panel(["email"]));

    // Somebody looking for Russian is looking for "Русский", not for "Russian".
    expect(screen.getByRole("button", { name: "Русский" })).toBeDefined();
    expect(document.querySelector('[data-sign-in-language="ru"]')).not.toBeNull();
    // And not the language already being read.
    expect(document.querySelector('[data-sign-in-language="en"]')).toBeNull();
  });

  it("renders the whole surface in Russian for a Russian reader", () => {
    render(
      <SignInPanel
        t={ru}
        locale="ru"
        available={["google", "email"]}
        googleAction={noop}
        emailAction={noopWithForm}
        languageAction={noopWithLocale}
      />,
    );

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(catalogues.ru["signIn.title"]);
    expect(screen.getByLabelText(catalogues.ru["signIn.emailLabel"])).toBeDefined();
    expect(screen.getByRole("button", { name: "English" })).toBeDefined();
  });

  it("labels the address field without a placeholder standing in for a label", () => {
    render(panel(["email"]));
    const field = screen.getByLabelText(text("signIn.emailLabel"));

    expect(field.getAttribute("type")).toBe("email");
    expect(field.getAttribute("placeholder")).toBeNull();
    expect(field.getAttribute("required")).not.toBeNull();
  });
});
