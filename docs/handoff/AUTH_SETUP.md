# Sign-in setup — operator runbook

What an operator has to provision before this product can let a customer sign in, and what the product
does when they have not. Variable **names** only: no credential, key, secret or address belongs in this
repository, and none is in it.

Decided by the owner on 2026-10-28 (ADR-022, Issue #117): **Google OAuth/OIDC** and a **one-time email
link**, both available for public self-serve registration and sign-in. No password authentication exists,
and none is planned.

## What the product does with no configuration

It boots, and it offers nothing. `availableSignInMethods` reports each method as withheld with a reason,
the sign-in page says so plainly instead of rendering a button that fails at a provider, and no other
service loses the ability to start. A method that is **half** configured — a client id with no secret, a
mail server with no sender — is treated as not configured and reported as `PARTIALLY_CONFIGURED`, because
the alternative is a customer meeting the failure where nobody can read it.

## Variables

Set these per environment. Staging and production are separate registrations with separate secrets; they
are not one client with two redirect URIs.

| Variable | Required for | Notes |
|---|---|---|
| `AUTH_SECRET` | both methods | **Unique per environment.** Already required by `apps/web/src/env.ts`. Rotating it invalidates every session, which is the intended behaviour after a suspected leak. |
| `AUTH_URL` | both methods | The absolute origin this deployment is reached at, e.g. `https://app.example`. This exact name, because Auth.js reads it itself: it is the only way to stop the library building sign-in links from the request's `Host` header, and setting it is also what makes the library trust the host at all. **Never derived from the request.** `Host` is a header, and a one-time link built from one is the credential mailed to whoever set it. Plain `http` is accepted only when `NODE_ENV=development`; in production it withholds both methods. A path is ignored — only the origin is used. |
| `GOOGLE_CLIENT_ID` | Google | From the Google Cloud console, OAuth 2.0 Client ID of type *Web application*. |
| `GOOGLE_CLIENT_SECRET` | Google | Same client. Server-side only; it is never sent to a browser, never logged, and never written to a test snapshot. |
| `AUTH_EMAIL_SERVER` | email link | An SMTP connection URL, e.g. `smtps://user:password@smtp.example:465`. Any SMTP service the deployment already trusts; the product is coupled to none. |
| `AUTH_EMAIL_FROM` | email link | The sender identity those links are sent as, e.g. `Omnichannel <no-reply@example.com>`. Must be an address the sending domain below is authorized for. |

## Google: what to register

1. Create an OAuth client in the Google Cloud console for **this** environment.
2. Authorized redirect URI: `<AUTH_URL>/api/auth/callback/google` — exactly, including the scheme and
   with no trailing slash.
3. Authorized JavaScript origin: `<AUTH_URL>`.
4. Scopes: **`openid email profile` and nothing else.** The product reads who somebody is; it does not act
   on their Google account, does not read mail, does not touch Workspace administration. A broader scope
   would be a consent screen customers are right to refuse.
5. The consent screen needs a privacy policy URL and must stay truthful as the product changes. Publishing
   it for external users is a separate step with its own review, and is **not** part of this task.

## Email: what to provision

1. A sending domain with **SPF, DKIM and DMARC** published and verified. Without it, links land in spam and
   a sign-in that silently does not arrive is indistinguishable from a broken product.
2. An SMTP user whose credentials appear only in `AUTH_EMAIL_SERVER`, scoped to sending.
3. A bounce and complaint route somebody reads.
4. Verify delivery to at least one mailbox outside the sending domain before enabling the method publicly.

The product cannot check any of this, and does not claim to. It validates that the variables are present
and well-shaped; everything above is a property of the deployment.

## Account linking, deliberately off

Two methods and one email address do **not** link automatically. Somebody who registered with Google and
later asks for an email link to the same address is told their address is registered with a different
method, and is not signed in. That is Auth.js's cautious default and it is kept, because automatic linking
on a matching email address is an account-takeover path the moment any provider's verification is weaker
than it looks. A reviewed, already-authenticated linking flow would be a separate change.

## Release blockers — none of these is code

Public self-serve registration stays off until all of them are true:

- [ ] Google OAuth client provisioned for the environment, redirect URI exact, scopes `openid email profile`.
- [ ] Sending domain verified with SPF, DKIM and DMARC; a real delivery test passed.
- [ ] `AUTH_SECRET` unique to the environment and not the staging value.
- [ ] `AUTH_URL` is the HTTPS origin customers actually reach.
- [ ] Terms acceptance and privacy copy approved — the acceptance mechanism exists (Issue #47) and the
      wording is the owner's.
- [ ] Staging verification of both flows by a person, including an expired link and a cancelled Google
      consent.
- [ ] Explicit owner release authorization.

Nothing in this repository can tick these, and no test asserts that they are ticked. A green build means
the flows are implemented and guarded, not that this deployment can send mail.
