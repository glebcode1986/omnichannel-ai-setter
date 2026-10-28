/**
 * Sending the link, against a transport that records instead of sending (#117).
 */
import { describe, expect, it } from "vitest";

import { publicLocaleFrom, PUBLIC_LOCALE_COOKIE } from "./public-locale";
import { sendSignInLink, type MailTransport, type OutgoingMail } from "./sign-in-mailer";
import { catalogues } from "@/i18n/catalogue";

function recorder(): MailTransport & { readonly sent: OutgoingMail[] } {
  const sent: OutgoingMail[] = [];
  return { sent, send: (mail) => { sent.push(mail); return Promise.resolve(); } };
}

const URL_WITH_TOKEN = "https://app.example/api/auth/callback/nodemailer?token=abc&email=x%40y.test";
const EXPIRES = new Date("2026-10-28T19:00:00.000Z");

describe("sending a sign-in link", () => {
  it("sends to the address asked for, from the configured identity", async () => {
    const transport = recorder();

    await sendSignInLink(transport, {
      identifier: "someone@example.com",
      url: URL_WITH_TOKEN,
      expires: EXPIRES,
      from: "Omnichannel <no-reply@app.example>",
    });

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toMatchObject({ to: "someone@example.com", from: "Omnichannel <no-reply@app.example>" });
    expect(transport.sent[0]?.text).toContain(URL_WITH_TOKEN);
  });

  it("writes the message in the language of the page that asked", async () => {
    const transport = recorder();

    await sendSignInLink(transport, {
      identifier: "someone@example.com",
      url: URL_WITH_TOKEN,
      expires: EXPIRES,
      from: "no-reply@app.example",
      cookieHeader: `theme=dark; ${PUBLIC_LOCALE_COOKIE}=ru; other=1`,
    });

    expect(transport.sent[0]?.subject).toBe(catalogues.ru["signInEmail.subject"]);
  });

  it("falls back to English when the page expressed no choice", async () => {
    const transport = recorder();

    await sendSignInLink(transport, { identifier: "a@b.test", url: URL_WITH_TOKEN, expires: EXPIRES, from: "f@b.test" });

    expect(transport.sent[0]?.subject).toBe(catalogues.en["signInEmail.subject"]);
  });

  it("lets a transport failure propagate rather than claiming a mail was sent", async () => {
    // Telling somebody to check an inbox nothing was sent to is worse than an error: they wait instead of
    // trying again.
    const failing: MailTransport = { send: () => Promise.reject(new Error("smtp refused")) };

    await expect(
      sendSignInLink(failing, { identifier: "a@b.test", url: URL_WITH_TOKEN, expires: EXPIRES, from: "f@b.test" }),
    ).rejects.toThrow("smtp refused");
  });
});

describe("the public language choice", () => {
  it("reads the chosen locale out of a cookie header", () => {
    expect(publicLocaleFrom(`${PUBLIC_LOCALE_COOKIE}=ru`)).toBe("ru");
    expect(publicLocaleFrom(` a=1; ${PUBLIC_LOCALE_COOKIE}=en ; b=2`)).toBe("en");
  });

  it("ignores a value that is not a locale this product has", () => {
    // The cookie is attacker-settable, so the worst a hostile value may do is pick between catalogues.
    for (const hostile of [`${PUBLIC_LOCALE_COOKIE}=de`, `${PUBLIC_LOCALE_COOKIE}=../../etc/passwd`, `${PUBLIC_LOCALE_COOKIE}=`]) {
      expect(publicLocaleFrom(hostile)).toBe("en");
    }
  });

  it("falls back with no cookie at all", () => {
    expect(publicLocaleFrom(undefined)).toBe("en");
    expect(publicLocaleFrom(null)).toBe("en");
    expect(publicLocaleFrom("")).toBe("en");
    expect(publicLocaleFrom("unrelated=1")).toBe("en");
  });

  it("does not match a cookie whose name merely ends with the same letters", () => {
    expect(publicLocaleFrom(`not_${PUBLIC_LOCALE_COOKIE}=ru`)).toBe("en");
  });
});
