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

/** An SMTP transport built from a connection URL. Constructed per send; nodemailer pools internally. */
export function smtpTransport(server: string): MailTransport {
  return {
    send: async (mail) => {
      const transport = createTransport(server);
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
