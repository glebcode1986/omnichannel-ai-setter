/**
 * Sending the one-time sign-in link (#117).
 *
 * The transport is a port with exactly one method, and that is the whole point of the shape: the
 * localized message, the fail-closed behaviour and the "never log the link" rule are all testable against
 * a transport that records instead of sending, so none of them has to be verified by mailing something.
 *
 * SMTP, because the accepted decision names "email one-time magic link" and not a vendor: any service a
 * deployment already trusts speaks it, and the product is coupled to none. `nodemailer` is pinned inside
 * the peer range `@auth/core` itself declares (`^7.0.7 || ^8.0.5`), so the SMTP client is the one the
 * installed Auth.js expects rather than the newest one.
 *
 * **Nothing here logs the URL.** It is the credential for one click; a link in an application log is a
 * sign-in available to anybody who can read logs, which in most deployments is more people than can read
 * the mailbox it was sent to.
 */
import { createTransport } from "nodemailer";

import { publicLocaleFrom } from "./public-locale";
import { signInEmail } from "./sign-in-email";

export interface OutgoingMail {
  readonly to: string;
  readonly from: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/** What a transport has to be able to do, and nothing more. */
export interface MailTransport {
  send: (mail: OutgoingMail) => Promise<void>;
}

/**
 * How long a send may take before it is a failure.
 *
 * Nodemailer's own defaults are two minutes to connect, thirty seconds for the greeting and ten minutes
 * of socket inactivity. Behind a form submission those are not timeouts; they are a hang. Measured on
 * the development host, which is a cloud machine with outbound 25, 465 and 587 blocked — the usual
 * anti-spam policy: the request sat open with no error, the page never moved off the form, and nothing
 * was logged, because nothing had failed yet. The person is told neither that a link is coming nor that
 * it is not.
 *
 * Twenty seconds in the worst case, which is long enough for a slow relay and short enough that the
 * refusal reaches the page. The three are separate because they fail differently: a blocked port never
 * connects, a wedged relay accepts the connection and never greets, and a relay that dies mid-message
 * leaves a socket open with nothing on it.
 */
const CONNECTION_TIMEOUT_MS = 10_000;
const GREETING_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 20_000;

/**
 * The connection URL with the timeouts above attached, unless the deployment set its own.
 *
 * Nodemailer reads its options off the query string of a connection URL, which is why these are added
 * here rather than by parsing the URL into host, port and credentials ourselves: that parsing is the one
 * thing `createTransport` is already trusted to do, and a second implementation of it is a second place
 * for `smtps:` or a percent-encoded password to be read differently.
 *
 * A value already in the URL wins. The contract is "any SMTP service a deployment already trusts", and a
 * deployment that has decided its relay needs forty seconds knows something this file does not.
 *
 * Exported for the test, which is the only way to see what `createTransport` is handed: the transporter
 * is built inside `send`, and the question — do these three values survive nodemailer's own URL parser —
 * cannot be answered from outside it.
 */
export function withTimeouts(server: string): string {
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    // Not parseable as a URL. `createTransport` will refuse it and say so; this must not be the thing
    // that throws first, because its message would be about a URL rather than about SMTP.
    return server;
  }
  for (const [name, value] of [
    ["connectionTimeout", CONNECTION_TIMEOUT_MS],
    ["greetingTimeout", GREETING_TIMEOUT_MS],
    ["socketTimeout", SOCKET_TIMEOUT_MS],
  ] as const) {
    if (!url.searchParams.has(name)) {
      url.searchParams.set(name, String(value));
    }
  }
  return url.toString();
}

/** An SMTP transport built from a connection URL. Constructed per send; nodemailer pools internally. */
export function smtpTransport(server: string): MailTransport {
  return {
    send: async (mail) => {
      const transport = createTransport(withTimeouts(server));
      try {
        await transport.sendMail({ to: mail.to, from: mail.from, subject: mail.subject, text: mail.text, html: mail.html });
      } finally {
        // Releases the connection rather than leaving one open per request.
        transport.close();
      }
    },
  };
}

export interface SignInLinkRequest {
  /** The address the link was asked for. */
  readonly identifier: string;
  /** The absolute URL the core built, which already encodes the single-use token. */
  readonly url: string;
  readonly expires: Date;
  /** The `From` identity, which the deployment configures. */
  readonly from: string;
  /** The raw `Cookie` header of the request that asked, so the message matches the page's language. */
  readonly cookieHeader?: string | null;
}

/**
 * Sends the link, in the language of the page that asked for it.
 *
 * A failure is **not** swallowed. The caller — the provider's `sendVerificationRequest` — is expected to
 * let it propagate so Auth.js reports a failed sign-in attempt rather than the "check your email" page:
 * telling somebody to check an inbox nothing was sent to is the one outcome worse than an error, because
 * they will wait instead of trying again.
 */
export async function sendSignInLink(transport: MailTransport, request: SignInLinkRequest): Promise<void> {
  const locale = publicLocaleFrom(request.cookieHeader);
  const message = signInEmail(locale, request.url, request.expires);
  await transport.send({
    to: request.identifier,
    from: request.from,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });
}
