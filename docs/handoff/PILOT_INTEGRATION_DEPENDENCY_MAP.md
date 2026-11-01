# Free-Pilot Integration Dependency Map

Issue #123, item 4. What an invitation-only free pilot depends on, and the honest state of each
dependency at `855f7edaa07a916ec05fc5db00e18dee68047efb`.

`EXISTS` means implemented and reachable from production code. `CONFIG` means implemented and waiting
only on a value. `MISSING` means no implementation. `BLOCKED` means implemented and unreachable.

## 1. Invitation gate

**MISSING.** There is no invitation mechanism of any kind. Searching the domain, persistence and server
layers for `invite`/`invitation` returns four hits, all of them the ordinary English word inside comments
about unrelated code — a positive control on the search is that it does find those comments, so the
search works and the feature is absent.

Consequence: "invitation-only" is today a property of *who is told the URL*, not a property the product
enforces. Since PR #118 the sign-in page is public and self-serve: anyone who reaches the origin with
Google OAuth or an email link configured can create an account.

For the pilot this is the gap with the widest blast radius after the delivery defect, because it is the
difference between "a few businesses we chose" and "whoever finds the link". Options, none of them
chosen here: keep the origin unpublished and accept the risk; put an allowlist in front of sign-in;
disable one or both providers and admit accounts by hand.

## 2. Authentication — Google and Resend

**CONFIG.** Both methods are implemented (ADR-022, Issue #117) and each is offered only when fully
configured; a half-configured method is reported as withheld with a reason rather than rendered as a
button that fails where a customer cannot see. The reasons are `NOT_CONFIGURED`,
`PARTIALLY_CONFIGURED`, `NO_BASE_URL` and `INSECURE_BASE_URL`.

Needed values: `AUTH_URL` (the one origin; no request header substitutes for it),
`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, and `AUTH_EMAIL_FROM`/`AUTH_EMAIL_SERVER` for the mail path.
The owner's choices — Google OAuth and Resend sending from `no-reply@mixamart.com` — are product
decisions already made; this document does not assert the accounts or credentials exist.

One behaviour worth knowing before testing: `signIn()` runs in-process, so a server action can bypass
an HTTP-level rate limiter. That was addressed in #118; re-verify it after any auth change.

## 3. Safe pilot entitlements — the `FREE_BETA` grant

**MISSING, and constrained.** The domain has six normalized subscription states —
`TRIALING`, `ACTIVE`, `PAST_DUE`, `GRACE`, `CANCELED_PENDING_END`, `INACTIVE` — and five of them permit
paid work. There is no free-pilot state.

The directive forbids simply prolonging the accepted 14-day self-serve trial globally. So a grant must
satisfy all of these, and the list is the point of this section:

1. **Not a paid subscription.** It must not create one, and must not silently convert a user to paid.
2. **Must not weaken accepted trial semantics.** `paidWorkPermitted` already refuses once a trial's
   `trialEndsAt` has passed; a pilot grant must not become a way to re-open an expired trial.
3. **Owner-controlled expiry and extension**, explicit rather than inferred, and revocable.
4. **Per-workspace, not global.** Flipping a platform-wide switch is how a pilot becomes a free product.
5. **Within safety and cost limits.** There is no per-workspace AI spend ceiling today (see §6), so
   "full supported features" needs a bound that does not exist yet.
6. **Adding a seventh subscription state changes core entity semantics**, which `CLAUDE.md` places
   outside what may be decided without an ADR. If the implementation turns out to need one, the ADR comes
   first.

Design is deliberately not attempted here — Issue #123 is an audit, and item 6 lists this as a separately
scoped follow-up.

## 4. Meta authorizations

**CONFIG, with one attestation that no API provides.**

Instagram: `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `INSTAGRAM_REDIRECT_URI` are **required to boot**
`apps/web` at all, so a pilot with no Instagram still has to supply values — which invites placeholders
into production configuration. `INSTAGRAM_HUMAN_AGENT_APPROVAL` must be set to `APPROVED` only once Meta
has approved the Human Agent feature, and **no API reports this**: it is an operator attestation, and
setting it falsely widens what the product believes it may do.

WhatsApp: `WHATSAPP_APP_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_SIGNUP_CONFIG_ID` are optional together,
and without them the connect endpoints refuse with `not_configured` instead of starting a flow that
cannot be finished. Embedded Signup v2 and v3 were retired 2026-10-15; the implementation targets v4.
`WHATSAPP_GRAPH_VERSION` is a deployment default.

Before any pilot business connects its own real assets, three things must be verified outside the
product: the needed Meta permissions are granted, the business genuinely owns or is authorized for the
account, and the privacy/data-processing requirements are met. **"Free" removes none of those
obligations**, and the directive says so explicitly.

## 5. AI provider, transcription and retrieval keys

**CONFIG.** `ANTHROPIC_API_KEY` is **required** for the worker to boot — the one place where an absent
key is a hard stop rather than a degraded mode. `AI_REPLY_MODEL`, `AI_REPLY_MAX_OUTPUT_TOKENS`,
`AI_PERSONA` and `AI_REPLY_TIMEOUT_MS` have defaults and are deployment configuration.

Retrieval degrades honestly: without `VOYAGE_API_KEY` and the `AI_EMBEDDING_*` values, search runs
lexical-only rather than returning silently empty results, and a configured dimension that disagrees with
the `vector(1024)` column is caught at runtime (`apps/worker/src/embeddings.ts:24-31` logs
`worker.embedding_dimensions_mismatch` and falls back to lexical).

Transcription is off without its key. The deployed instance has none of these three, which is why no
part of the AI path has ever run there.

## 6. DRAFT plus human review

**BLOCKED — this is the pilot's central dependency and it does not work.** See
`PILOT_READINESS_AUDIT.md` §3.1: approving a draft or composing a reply writes a `SCHEDULED` row that
nothing dispatches, while the UI reports success, and an orphaned row then blocks composing another
reply in that conversation.

Everything else in this map is a configuration or policy question. This one is a defect, and it makes the
mandated DRAFT-first mode non-functional. It must be fixed and verified before a real business is
invited.

Related and also missing: **no per-workspace AI spend ceiling**, so a free pilot's cost is bounded only
by how much the invited businesses happen to use.

## 7. Privacy notice, terms and processing agreements

**EXISTS as drafts, MISSING as published artefacts.** `docs/legal-drafts/` holds unpublished,
unapproved EN and RU drafts (#121, PR #122), and the directive forbids publishing them. Terms acceptance
is implemented and recorded before a redirect rather than inferred from a charge (#101).

A pilot needs, and does not have: a pilot-specific privacy notice saying what is processed and why, the
minimum processing agreements with each pilot business, and a named support contact. Seller identity in
the drafts is still a placeholder by design.

## 8. Failure, deletion, revocation and support

| Need | State |
|---|---|
| Data export | Implemented (#94) |
| Retention and deletion | Implemented; 96 of 99 foreign keys `RESTRICT`, and an opt-out cannot be stripped of its person |
| Account revocation | Partially — a platform role can be withdrawn, but see the bootstrap deadlock below |
| Kill switch, four scopes, widest-wins | Implemented and read through one shared predicate on the paths that actually send — **and unreachable on a fresh deployment** |
| Alerting a human | **MISSING.** Log lines and audit events exist; nothing turns a condition into a notification |
| Support contact | **MISSING** as a product surface |

The bootstrap deadlock is `PILOT_READINESS_AUDIT.md` §3.2: every runtime control authorizes through a
`platform_members` row, and the only production writer of that table requires a permission only an
existing platform admin holds. One hand-written `INSERT` fixes it; nothing documents that today.

## 9. Billing hard-disable, at UI and server

| Layer | State |
|---|---|
| Server | **PASS by absence.** With `STRIPE_ROUTES` unset no adapter registers (`apps/web/src/server/billing-adapters.ts:38-40`), and the worker and queue surface reference no payment provider at all. The dependency matrix forbids the adapter reaching the database, so a paid entitlement cannot be activated without a verified provider event |
| Server, as a guarantee | **BLOCKER.** The disable is an omission, not a decision: no flag, policy or variable states that payments are off. That shape regresses the first time someone sets a variable to test something |
| UI | **GAP.** Plan and checkout affordances render from the catalogue rather than from adapter availability, so an operator can be shown a path that cannot complete |

Also unresolved and needing an owner decision: whether the commercial catalogue should be published at
all in a free pilot. Publishing it is a deployment step (`catalog:publish`), and a catalogue with prices
in a pilot where nothing can be bought is a contradiction a pilot business will notice.

## 10. Dependency order

Reading the map as a sequence, nothing downstream is worth configuring until the two defects are closed:

1. the delivery path (§6) — otherwise DRAFT-first cannot deliver a single reply;
2. the operator bootstrap (§8) — otherwise nobody can stop it;
3. then the invitation gate (§1), because "invitation-only" is currently not enforced;
4. then auth and Meta configuration (§2, §4), which are value-supply tasks;
5. then the pilot grant (§3), which needs an ADR if it needs a new state;
6. then privacy artefacts and a support contact (§7, §8);
7. the explicit payment refusal (§9) can proceed in parallel with any of the above.
