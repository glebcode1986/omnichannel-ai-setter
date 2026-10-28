/**
 * The sign-in message, including the two things it must not say (#117).
 *
 * A mail that greeted a returning customer differently from a new one would turn the public sign-in form
 * into an oracle: anybody could ask it, one address at a time, whether that address belongs to a customer
 * here. So the message is addressed to the request rather than to a person, and these cases pin that.
 */
import { describe, expect, it } from "vitest";

import { signInEmail, signInEmailLocales } from "./sign-in-email";
import { catalogues } from "@/i18n/catalogue";

const URL_WITH_TOKEN = "https://app.example/api/auth/callback/nodemailer?token=abc123&email=someone%40example.com";
const EXPIRES = new Date("2026-10-28T18:30:00.000Z");

describe("the one-time sign-in message", () => {
  it("carries the link verbatim in the text body", () => {
    // The link *is* the credential for one click, so a mangled one is a sign-in nobody can complete.
    expect(signInEmail("en", URL_WITH_TOKEN, EXPIRES).text).toContain(URL_WITH_TOKEN);
  });

  it("escapes the link where it becomes an attribute and a label", () => {
    const { html } = signInEmail("en", URL_WITH_TOKEN, EXPIRES);

    expect(html).toContain(`href="${URL_WITH_TOKEN.replaceAll("&", "&amp;")}"`);
    // The raw ampersand must not survive into the attribute, which is how a URL turns into two.
    expect(html).not.toContain("token=abc123&email");
  });

  it("escapes a link that tries to close the attribute it sits in", () => {
    const hostile = 'https://app.example/x?a="><script>alert(1)</script>';

    const { html } = signInEmail("en", hostile, EXPIRES);

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("says when the link stops working, in the reader's locale", () => {
    expect(signInEmail("en", URL_WITH_TOKEN, EXPIRES).text).toContain("stops working");
    expect(signInEmail("ru", URL_WITH_TOKEN, EXPIRES).text).toContain("перестанет работать");
  });

  it("leaves no placeholder unfilled", () => {
    for (const locale of signInEmailLocales()) {
      const message = signInEmail(locale, URL_WITH_TOKEN, EXPIRES);
      for (const part of [message.subject, message.text, message.html]) {
        expect(part, locale).not.toContain("{when}");
      }
    }
  });

  it("exists in every locale the product has, and differs between them", () => {
    // Identical bodies would mean one locale is quietly English.
    const en = signInEmail("en", URL_WITH_TOKEN, EXPIRES);
    const ru = signInEmail("ru", URL_WITH_TOKEN, EXPIRES);

    expect(signInEmailLocales()).toEqual(Object.keys(catalogues));
    expect(ru.subject).not.toBe(en.subject);
    expect(ru.text).not.toBe(en.text);
  });

  it("never says whether the address already has an account", () => {
    // The oracle this message is shaped to avoid. No greeting, no "welcome back", no "your account".
    const forbidden = [
      "welcome back",
      "your account",
      "existing account",
      "new account",
      "registered",
      "добро пожаловать",
      "ваш аккаунт",
      "уже зарегистрирован",
    ];
    for (const locale of signInEmailLocales()) {
      const message = signInEmail(locale, URL_WITH_TOKEN, EXPIRES);
      const body = `${message.subject}\n${message.text}`.toLowerCase();
      for (const phrase of forbidden) {
        expect(body, `${locale} / ${phrase}`).not.toContain(phrase);
      }
    }
  });

  it("tells somebody who did not ask for it that nothing happened", () => {
    for (const locale of signInEmailLocales()) {
      expect(signInEmail(locale, URL_WITH_TOKEN, EXPIRES).text, locale).toContain(
        catalogues[locale]["signInEmail.ignore"],
      );
    }
  });
});
