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
| `AUTH_SIGN_IN_ACCESS` | the private pilot | `open` or `invite`; absent means `open`. `invite` sends a link only to an address in `AUTH_INVITE_ALLOWLIST` and withholds Google entirely. **Any other value refuses the boot**, deliberately: a gate one keystroke from admitting the public should fail loudly rather than quietly. See *The private pilot* below. |
| `AUTH_INVITE_ALLOWLIST` | the private pilot | The invited addresses, separated by commas, semicolons or newlines. Read only while the mode is `invite`. **Empty invites nobody**, never everybody. Case and surrounding spaces do not matter; a wildcard does not exist — `*@example.com` is one literal address nobody has. |
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

### Check the port before you check anything else

**Most cloud hosts block outbound 25, 465 and 587**, which are the three ports an SMTP URL is usually
written with. It is an anti-spam policy and it is silent: the connection is dropped rather than refused,
so there is no error to read — the send simply does not finish.

This is worth naming because of how it presents. The verification token is written to the database
*before* the message is handed to the transport, so the database says a link was issued; the page stays
on the form; and nothing is logged, because the product deliberately logs nothing on this path and
nothing has failed yet. Every signal available says the deployment is configured correctly.

Before concluding anything about credentials or DNS, open a socket from **inside the container that
sends**, not from a laptop:

```
docker compose exec web node -e 'const s=require("node:net").createConnection({host:"smtp.example",port:465},()=>{console.log("open");s.end()});s.setTimeout(7000,()=>{console.log("blocked");s.destroy()})'
```

If it prints `blocked`, ask the provider for an alternate port rather than changing anything else. Most
offer one above 2000 — `2465` for implicit TLS and `2587` for STARTTLS are the usual pair, and they are
not covered by the block. Prefer the implicit-TLS port and the `smtps:` scheme: there is then no
cleartext window at all, where STARTTLS has one before the upgrade.

The transport gives up after twenty seconds in the worst case regardless (`sign-in-mailer.ts`), so a
blocked port now produces a refusal the page can show instead of a request that hangs. That is a
backstop, not a fix: a refusal every time is still a sign-in nobody can complete.

### What has actually been exercised, and when

Measured on the development deployment on **2026-11-06**, against the real origin over TLS with a
browser, not with `curl`. This is the environment half of the evidence: it says nothing about the code in
any particular commit, and the code half is the test suite.

| Step | Result |
|---|---|
| Sending domain in the provider | `keepsaybot.online` verified, sending enabled |
| Outbound SMTP from inside the `web` container | 25, 465, 587 time out · **2465 and 2587 open** |
| Link requested from the live form | accepted, page reached "Check your email" |
| Provider's delivery status | **delivered** |
| Link in the message | built from `AUTH_URL`, not from the `Host` header |
| Clicking it | session created, landed on `/workspaces`, address marked verified |
| Clicking it a second time | refused — `/sign-in?error=Verification` |
| Clicking a link whose row had been expired by hand | refused the same way, and the row was consumed |
| Six requests for one address inside the window | five sent, **the sixth sent nothing**, logged `signin.rate_limited` with `refusedBy=IDENTIFIER` and no address |

Until that day the click had **never** been exercised here: the only three tokens the database held were
unspent and expired, and two of the three requests that made them predate the port fix and never left the
building at all.

## The private pilot: invitation only

The owner's decision of 2026-11-05 (#133): the beta is private, free and open by invitation to known
businesses, with the email link as the only way in. Two variables turn it on:

```
AUTH_SIGN_IN_ACCESS=invite
AUTH_INVITE_ALLOWLIST=first@business.example, second@business.example
```

**To invite somebody:** add the address, restart the web container, tell them to ask for a link at
`/sign-in`. **To revoke:** take the address out and restart. Revocation reaches a link that was already
sent — the gate is consulted again when a link is spent, not only when one is asked for — but it does
**not** end a session that address already has. Delete its rows in `auth_sessions` for that.

A restart is required because the environment is read from the process, so an edited `.env` reaches
nothing until the container is recreated.

**What an uninvited visitor sees:** the same page an invited one does. They type their address, they are
told a link is on its way, and no link is sent, no token is written and no account is created. That is
deliberate — the alternative tells a stranger which of their guesses is somebody's invitation — and it is
why the sign-in page says "KeepSayBot is in a closed pilot" in invite mode rather than "create an
account". **It also means an invited tester who mistypes their own address gets the same reassuring page
and no mail**, so when somebody says the link never arrived, check the spelling in the allowlist before
checking the transport.

**Google is withheld in this mode**, with the reason `INVITE_ONLY`, and its configuration is left alone.
It is not a method the gate can hold: the refusal would land only after a stranger had already consented,
which is a button into a dead end. Putting the mode back to `open` offers it again, unchanged.

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
- [ ] `AUTH_SIGN_IN_ACCESS` is the mode that was decided. While the pilot is private it is `invite`;
      leaving it absent is public self-serve registration, which is a product decision and not a default
      to arrive at by forgetting.

## Housekeeping nothing does for you

Expired verification tokens are **never pruned**. `@auth/core` deletes a token when a link is spent, and
an unspent one stays in `auth_verification_tokens` after it expires — six were sitting in the development
database on 2026-11-06, the oldest from the day before. They are unusable, so this is litter rather than
exposure, but the table grows with every link nobody clicks:

```sql
DELETE FROM auth_verification_tokens WHERE expires <= now();
```

Nothing in this repository can tick these, and no test asserts that they are ticked. A green build means
the flows are implemented and guarded, not that this deployment can send mail.
