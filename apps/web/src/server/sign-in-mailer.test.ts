/**
 * Sending the link, against a transport that records instead of sending (#117).
 */
import net from "node:net";
import type { AddressInfo } from "node:net";

import { createTransport } from "nodemailer";
import { describe, expect, it } from "vitest";

import { publicLocaleFrom, PUBLIC_LOCALE_COOKIE } from "./public-locale";
import { sendSignInLink, smtpTransport, withTimeouts, type MailTransport, type OutgoingMail } from "./sign-in-mailer";
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

/**
 * A send that cannot finish has to fail, and nodemailer's own defaults do not make it fail in any time
 * a person waiting on a form would recognise as an answer.
 */
describe("the SMTP transport", () => {
  /** What nodemailer resolved the URL to — the only place the parsed options are visible. */
  function optionsFor(server: string): Record<string, unknown> {
    const built = createTransport(withTimeouts(server)) as unknown as { transporter: { options: Record<string, unknown> } };
    return built.transporter.options;
  }

  it("hands nodemailer three timeouts, and nodemailer keeps them", () => {
    // Both halves matter. Attaching query parameters that the parser silently drops would leave this
    // file looking careful and the transport running on two-minute defaults.
    const options = optionsFor("smtps://user:secret@smtp.example.test:2465");

    expect({
      connectionTimeout: options["connectionTimeout"],
      greetingTimeout: options["greetingTimeout"],
      socketTimeout: options["socketTimeout"],
    }).toEqual({ connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 });

    // And the URL still says what it said: scheme, port and credentials are nodemailer's to read, which
    // is why they are not re-parsed here.
    expect({ host: options["host"], port: options["port"], secure: options["secure"] }).toEqual({
      host: "smtp.example.test",
      port: 2465,
      secure: true,
    });
  });

  it("leaves a deployment's own timeout alone", () => {
    // "Any SMTP service a deployment already trusts" is the contract. A relay that needs longer is a
    // thing the deployment knows and this file does not.
    expect(optionsFor("smtp://u:p@smtp.example.test:587?greetingTimeout=45000")["greetingTimeout"]).toBe(45_000);
  });

  it("is not confused by a URL it cannot parse", () => {
    // `createTransport` refuses this and says something about SMTP. If `new URL` threw first, the person
    // reading the log would be told about a URL instead.
    expect(withTimeouts("not a url")).toBe("not a url");
  });

  it("gives up on a relay that accepts the connection and never greets", async () => {
    // The failure measured on the development host, reproduced in miniature: a socket that opens and
    // then says nothing. Nodemailer's default is thirty seconds of that before it admits anything is
    // wrong, and the request stays open the whole time — which is how a sign-in page sat on the form
    // with no link coming and no error shown. The timeouts are overridden to milliseconds here, which
    // also exercises the rule above.
    const silent = net.createServer(() => {
      // Deliberately empty: accept the connection and send no banner.
    });
    await new Promise<void>((resolve) => {
      silent.listen(0, "127.0.0.1", resolve);
    });
    const { port } = silent.address() as AddressInfo;

    try {
      const transport = smtpTransport(`smtp://u:p@127.0.0.1:${String(port)}?connectionTimeout=200&greetingTimeout=200&socketTimeout=400`);
      const started = Date.now();
      await expect(
        transport.send({ to: "a@b.test", from: "c@d.test", subject: "s", text: "t", html: "<p>t</p>" }),
      ).rejects.toThrow();
      expect(Date.now() - started, "it must give up, not wait out nodemailer's default").toBeLessThan(5_000);
    } finally {
      await new Promise<void>((resolve) => {
        silent.close(() => {
          resolve();
        });
      });
    }
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
