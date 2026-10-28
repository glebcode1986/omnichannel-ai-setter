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
| `AUTH_TRUSTED_CLIENT_IP_HEADER` | per-caller rate limiting | The name of the header **your own reverse proxy sets and sanitizes**, e.g. `x-forwarded-for`. Leave it unset unless a proxy in front of this process overwrites that header on every request. See *Attributing a caller* below: setting it switches per-caller limiting on; leaving it unset leaves per-address limiting in place and nothing else. |

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

## Attributing a caller, and why it is off by default

Sign-in has two limits. One counts requests **per email address**, and it is always on: an address cannot
be spoofed, because the address is the thing being protected. The other counts **per caller**, and it is
off until `AUTH_TRUSTED_CLIENT_IP_HEADER` names a header.

The reason for that default is not caution for its own sake. A client address can only be read from a
request header, and a header is whatever the caller says it is unless something in front of this process
overwrites it. A limit keyed on a header this deployment does not control would be worse than no limit at
all: an attacker changes the value and is never counted, while several ordinary people behind one office
connection share a bucket and are refused. So the product declines to guess.

**Set it only if all of these are true.** A reverse proxy, load balancer or CDN terminates every request
before it reaches this process; it *overwrites* — not appends to — the header you are naming; and no route
to this process bypasses it. `x-forwarded-for` accumulates hops left to right and the product reads the
leftmost value, which is the one your proxy wrote, so a proxy that appends without stripping what arrived
hands the product an attacker-chosen value.

**What you get, and what you still do not get.** Configured, a single caller is limited across many
addresses — the flood the per-address rule cannot see, because every request names a different victim.
Unconfigured, that flood is unlimited: each address is still protected from repetition, and nothing stops
one caller asking for links at many addresses. That is a known, stated gap rather than an oversight, and
this variable is how it closes.

A refused request is answered exactly as an accepted one — the same page, the same status, no distinct
message — so neither a customer nor an attacker can tell a limit from a success. Do not expect a `429` in
logs or in a browser; look for the signal below instead.

## When Redis is unavailable

The limiter counts in Redis, because a per-process counter stops being a limit as soon as this app runs
more than one instance.

**It fails open on purpose.** If Redis cannot be reached, a sign-in attempt is allowed rather than refused.
Failing closed would lock every customer out of signing in during a Redis blip — including the operator who
would fix it — so the product chooses availability for the front door and makes the loss of protection
loud instead of silent.

**The signal to alert on is `signin.rate_limit_unavailable`**, emitted at `warn` on every attempt that
could not be counted. Treat it as "sign-in rate limiting is currently degraded", not as noise:

- **alert on the first occurrence**, not on a threshold — one of these means the protection is off now;
- while it is firing, per-caller *and* per-address limiting are both absent, so the sign-in form will send
  a link for every well-formed request it receives;
- it clears by itself when Redis is reachable again; there is nothing to restart and no counter to repair,
  because each window expires on its own.

**No email address appears in either sign-in log line**, by design: a log of refused sign-in attempts would
otherwise be a list of addresses somebody is interested in. What each one does carry, checked against the
code rather than described from memory:

| Event | Level | Fields |
|---|---|---|
| `signin.rate_limit_unavailable` | `warn` | `key` (a hash, no address), `windowMs`, `reason` (the error's name) |
| `signin.rate_limited` | `warn` | `endpoint`, `refusedBy` (`IDENTIFIER` or `CALLER`) |

The second is the ordinary one: it means a limit did its job. The first is the one to alert on.

## Release blockers — none of these is code

Public self-serve registration stays off until all of them are true:

- [ ] Google OAuth client provisioned for the environment, redirect URI exact, scopes `openid email profile`.
- [ ] Sending domain verified with SPF, DKIM and DMARC; a real delivery test passed.
- [ ] `AUTH_SECRET` unique to the environment and not the staging value.
- [ ] `AUTH_URL` is the HTTPS origin customers actually reach.
- [ ] `AUTH_TRUSTED_CLIENT_IP_HEADER` is set if — and only if — a trusted proxy overwrites that header;
      the per-caller limit is otherwise absent, which is acceptable but should be a decision.
- [ ] Alerting is in place on `signin.rate_limit_unavailable`, because sign-in rate limiting fails open.
- [ ] Terms acceptance and privacy copy approved — the acceptance mechanism exists (Issue #47) and the
      wording is the owner's.
- [ ] Staging verification of both flows by a person, including an expired link and a cancelled Google
      consent.
- [ ] Explicit owner release authorization.

Nothing in this repository can tick these, and no test asserts that they are ticked. A green build means
the flows are implemented and guarded, not that this deployment can send mail.
