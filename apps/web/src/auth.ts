import { PrismaAdapter } from "@auth/prisma-adapter";
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import Nodemailer from "next-auth/providers/nodemailer";

import { loadWebEnv } from "./env";
import { withoutProviderTokens } from "./server/auth-adapter";
import { getDb } from "./server/db";
import { availableSignInMethods, safeRedirectTarget } from "./server/sign-in-methods";
import { sendSignInLink, smtpTransport } from "./server/sign-in-mailer";

/**
 * Auth.js with Prisma-backed users, linked accounts and database sessions (ADR-009). Configuration is
 * resolved per request, so importing this module never reads the environment or opens a connection.
 * Authentication identifies the user only; workspace access is authorized separately
 * (see server/request-context.ts).
 *
 * **Two sign-in methods, both chosen by the owner on 2026-10-28** (ADR-022, Issue #117): Google
 * OAuth/OIDC and a one-time email link. No password authentication exists.
 *
 * Each provider is added **only when the configuration it needs is complete and usable**, which
 * `availableSignInMethods` decides and the sign-in page renders from. A half-configured method is absent
 * here and absent there, so the page cannot offer what this would refuse.
 *
 * **The origin is configuration, not the request.** In the installed version the emailed link is built
 * from `options.url.origin` and the only lever on it is the `AUTH_URL` environment variable, which
 * `@auth/core` reads itself; it is also what flips `trustHost` on. That is why `AUTH_URL` is the variable
 * `env.ts` declares and why both methods are withheld without it — a link built from the `Host` header is
 * a single-use credential delivered to whoever set the header. `trustHost` is deliberately **not** set
 * here: setting it true would silence the host check without changing which origin is used, which is the
 * dangerous half of the fix.
 *
 * **Account linking stays off.** `allowDangerousEmailAccountLinking` is not set on the Google provider, so
 * a Google profile cannot claim an account that registered by email at the same address. That is the one
 * switch that turns a matching email address into an account-takeover path, and turning it on is a
 * separate decision with its own review. The consequence is visible to people — the second method reports
 * `OAuthAccountNotLinked`, which lands on the sign-in page as an error the page explains.
 */
export const { handlers, auth, signIn, signOut } = NextAuth(() => {
  const env = loadWebEnv();
  const methods = availableSignInMethods(env);
  const baseUrl = methods.baseUrl;

  return {
    adapter: withoutProviderTokens(PrismaAdapter(getDb())),
    session: { strategy: "database" },
    secret: env.AUTH_SECRET,
    // Our own pages, so a refusal is explained in the reader's language instead of on a default screen.
    // `OAuthAccountNotLinked` is a *sign-in* error in this version and arrives at `signIn` rather than at
    // `error`, which is why the sign-in page is the one that reads `?error=`.
    pages: { signIn: "/sign-in", verifyRequest: "/sign-in/sent", error: "/sign-in" },
    providers: [
      ...(methods.available.includes("google") && env.GOOGLE_CLIENT_ID !== undefined && env.GOOGLE_CLIENT_SECRET !== undefined
        ? [
            Google({
              clientId: env.GOOGLE_CLIENT_ID,
              clientSecret: env.GOOGLE_CLIENT_SECRET,
              // Identity only, and stated explicitly rather than inherited: the version's own default is
              // the same three scopes in a different order, and a contract documented in one order and
              // requested in another is a contract nobody can check.
              authorization: { params: { scope: "openid email profile" } },
            }),
          ]
        : []),
      ...(methods.available.includes("email") && env.AUTH_EMAIL_SERVER !== undefined && env.AUTH_EMAIL_FROM !== undefined
        ? [
            Nodemailer({
              server: env.AUTH_EMAIL_SERVER,
              from: env.AUTH_EMAIL_FROM,
              // Fifteen minutes, not the version's default of a full day. The link is the account for one
              // click; a day is a long time for that to sit in an inbox, and the page promises "shortly".
              maxAge: SIGN_IN_LINK_MAX_AGE_SECONDS,
              // Our own sender, for one reason the default cannot serve: the message has to be in the
              // language of the page that asked for it. The token is generated and hashed by the core —
              // this only transports, and deliberately logs nothing, because the URL it is handed is the
              // credential.
              sendVerificationRequest: async ({ identifier, url, expires, request }) => {
                await sendSignInLink(smtpTransport(env.AUTH_EMAIL_SERVER ?? ""), {
                  identifier,
                  url,
                  expires,
                  from: env.AUTH_EMAIL_FROM ?? "",
                  cookieHeader: request.headers.get("cookie"),
                });
              },
            }),
          ]
        : []),
    ],
    callbacks: {
      /**
       * Where a completed sign-in may land.
       *
       * The default in this version returns `${baseUrl}${url}` for anything beginning with `/`, which
       * accepts `//evil.example` — a protocol-relative authority. `safeRedirectTarget` resolves the value
       * against this origin and compares origins instead, so a foreign destination becomes the chooser.
       * Absolute same-origin URLs have to keep working: the framework's own unauthorized redirect puts a
       * full `href` in `callbackUrl`.
       */
      redirect: ({ url, baseUrl: requestBaseUrl }) => {
        const origin = baseUrl ?? requestBaseUrl;
        return `${origin}${safeRedirectTarget(url, origin)}`;
      },
    },
  };
});

/** How long a one-time sign-in link is valid, in seconds — the unit the provider's `maxAge` is in. */
export const SIGN_IN_LINK_MAX_AGE_SECONDS = 15 * 60;
