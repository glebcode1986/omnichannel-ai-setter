# ADR-022: The first production sign-in method

**Status:** **Accepted** by the product owner on 2026-10-28, with a decision that **supersedes this
ADR's own recommendation**: both methods now rather than Google first and email later. Implemented in the
follow-up authorized as Issue #117; no identity provider has been *configured* or contacted, because that
is deployment input and not code — see `docs/handoff/AUTH_SETUP.md`.

**The owner's decision, recorded verbatim in effect:**

1. **Google OAuth/OIDC** for sign-up and sign-in, scopes `openid email profile` only.
2. **Email one-time link** for passwordless sign-up and sign-in.
3. Registration is **public self-serve**: both methods are available to new customers.
4. **No password-based account management is authorized**, and none exists.
5. No Facebook or other social provider is authorized.

Where this ADR recommended "B, with Google as the single first provider, and A added when a customer
without a Google account appears", the owner chose both at once. The reasoning below is kept unedited as
the record of what was proposed and why — the recommendation was not the decision, and rewriting it to
match the outcome would destroy the only evidence of what the choice was between.

**Context:** Issue #115 asked for the authenticated front door — the path by which a customer creates the
Workspace and Business Profile the product is built around — and for "a short concrete, security-conscious
owner-choice note proposing viable supported sign-in methods, operational requirements and default
recommendation". It explicitly did **not** authorize selecting or configuring an external identity
provider, and it required the sign-in gap to be surfaced rather than worked around. This is that note.

## The gap, stated exactly

`apps/web/src/auth.ts` is complete Auth.js wiring — Prisma adapter, database sessions (ADR-009), a secret
read per request, provider tokens stripped from the adapter's writes by `withoutProviderTokens` — with one
line unfinished:

```ts
// Sign-in providers are chosen with the authenticated app shell (P5-01); none are enabled yet.
providers: [],
```

With an empty `providers` array there is no sign-in route to send anybody to. Everything above it works:
`auth()` resolves a session when one exists, `requireSessionUser` refuses when one does not, and the whole
authorization chain below (`authorizeWorkspaceAccess`, roles, Business Profile scope) is exercised against
a real database by the journey suite using injected session identities.

So the honest statement of today's product is: **an authenticated person can now create a Workspace, create
a Business Profile, reach setup, connect a channel and obtain the trial — and nothing can make a person
authenticated.** The front door is built; the lock has no key yet. #115's definition of done says this in
the same words, and this ADR exists so the remaining decision is the owner's and not an implementation
detail somebody fills in.

## What the decision actually is

Not "which SDK". Three questions, in this order:

1. **Who may sign in at all** — anybody who arrives (public self-serve), or only an operator-created
   account (invite-only)? This decides whether the product has a public signup page, and therefore whether
   abuse control, email verification and a terms-acceptance gate are on the critical path. The terms gate
   already exists (#47, `legalAcceptance`), so invite-only would be a smaller surface, not a missing one.
2. **What proves identity** — a federated provider, a one-time code to an email address, or a password.
3. **What the deployment must then hold** — secrets, a sending domain, a consent screen somebody has to
   maintain.

## The three viable options, with what each costs to operate

**A. Email one-time code (Auth.js Email/Nodemailer provider).** The person types an address and receives a
single-use link or code; the adapter already has the `VerificationToken` table it needs.

- *Operationally:* an SMTP sender or a transactional email API, a verified sending domain with SPF/DKIM/DMARC,
  and a bounce/complaint route. One secret.
- *Security:* no password to leak, reuse or rotate. The email inbox becomes the account-recovery boundary,
  which is already true of every "reset my password" flow — this makes it explicit rather than secondary.
  Token lifetime and single use must be short and enforced server-side; Auth.js does both by default.
- *Against:* deliverability is a real operational burden, and a delayed email is a failed sign-in that
  looks like a broken product.

**B. A federated provider (Google, and/or Facebook).** One or two OAuth clients, no credential of the
customer's ever touching this system.

- *Operationally:* an app registration per provider, a client id and secret per environment, a redirect URI
  per environment, a privacy policy URL, and — for Google — a consent screen that must be kept truthful as
  scopes change. Two secrets per provider per environment.
- *Security:* strongest of the three. No password store, no email delivery on the critical path, and the
  provider absorbs credential-stuffing and MFA. Scope requested must stay `openid email profile` and nothing
  more: this product authenticates a person, it does not act on their Google account.
- *Against:* a third party can lock an account out, and account-linking has to be decided deliberately —
  two providers returning the same verified email either link to one user or do not, and Auth.js's default
  is the cautious one.
- *Note, not a recommendation:* the product already integrates Meta for Instagram and WhatsApp
  (`INSTAGRAM_APP_ID`, Embedded Signup). Reusing that app for *sign-in* would couple a customer's ability
  to log in to the same app registration their channel connection depends on. Two failures become one.

**C. Password credentials.** Email and password stored by this system.

- *Operationally:* the most code and the most ongoing obligation — a password hash (argon2id or bcrypt with
  a sensible cost), rate limiting and lockout, a reset flow that is itself an email flow (so option A's
  operational cost arrives anyway), breach-list checks, and a session-invalidation path on reset.
- *Security:* the weakest of the three and the only one that makes this product a holder of reusable
  secrets. Auth.js's own Credentials provider is explicitly not database-backed account management; it
  would be hand-written authentication on the critical path.
- *Against:* everything above. Offered here for completeness, not as a contender.

## Recommended default

**B, with Google as the single first provider, and A added when a customer without a Google account
appears.** Reasons, in order: it puts no reusable secret in this system, it keeps email delivery off the
sign-in path, it is two configuration values and a redirect URI per environment, and it is the option whose
failure modes are somebody else's expertise. A is the right second provider rather than the first because
its operational burden (a warmed sending domain) is work that must be done *before* the first customer, not
after.

Either way, two settings that belong to this decision and not to a later one:

- **`AUTH_SECRET` must differ per environment** and must not be the staging value. It is already required
  by `apps/web/src/env.ts`, so this is a deployment fact, not a code change.
- **Account linking stays off by default.** A second provider that returns an email already registered must
  not silently become the same user; this is the one Auth.js default worth stating explicitly, because
  turning it on later is a decision about account takeover.

## Consequences if this stays Proposed

The product is demonstrable and testable but not reachable: no customer can sign in, so no customer can use
the front door #115 built. Nothing in the repository claims otherwise — the issue's own definition of done
says "Public signup/sign-in is NOT complete while no Auth.js provider is configured", and
`docs/handoff/CURRENT_HANDOFF.md` carries the same statement.

This ADR is implemented by exactly one change plus configuration: entries in that `providers: []` array and
the matching secrets in deployment. Neither is in #115's scope and neither is done there.

## What was built, and what is still configuration (Issue #117)

Both methods are implemented behind validated configuration. The code decides availability from the
environment and reports it truthfully: a method with nothing configured is `NOT_CONFIGURED`, a method with
half of it is `PARTIALLY_CONFIGURED`, and **both** are withheld when there is no `AUTH_URL`, because
the only other source of an absolute URL for a callback or an emailed link is the request's own `Host`
header.

The two settings this ADR said belong to the decision were both kept: `AUTH_SECRET` is per environment,
and **account linking stays off** — two methods on one address do not merge, and somebody who registered
with Google and later asks for an email link is told so rather than signed in.

Still not code, and still blocking public rollout: a provisioned Google OAuth client per environment, a
sending domain verified with SPF/DKIM/DMARC, a real delivery test, approved terms and privacy copy,
staging verification by a person, and the owner's release authorization. `docs/handoff/AUTH_SETUP.md` is
the checklist; nothing in this repository can tick it, and no test asserts that it is ticked.
