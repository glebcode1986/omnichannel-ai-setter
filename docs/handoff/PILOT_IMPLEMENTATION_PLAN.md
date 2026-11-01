# Pilot Implementation Plan

Issue #123, items 3 and 6. A sequenced proposal, **not a release approval**, and not a licence to start
any of it: the directive says explicitly that these follow-ups must not be begun from this task.

Each candidate below states its scope, the evidence that would show it is done, and the owner permission
it needs. They are deliberately small and separately reviewable, because this project's accepted practice
is one branch per directive.

## 1. Environment isolation

### Production

The intended app origin is **`https://mixamart.com`**. The domain is purchased and the owner has DNS
access. **Nothing here asserts that DNS, TLS or the service are configured or reachable** — that is a
measurement, and `PILOT_HOST_INVENTORY_CHECKLIST.md` §D collects it read-only, because the directive
forbids changing live DNS.

### Staging — PROPOSED, not asserted

`https://staging.mixamart.com` is **proposed**. No claim is made that this name exists in DNS.

If it is created, `docs/specs/LAUNCH_READINESS.md` §2 requires it to be genuinely separate, and the
separations that matter most for this product are:

| Resource | Why it must be distinct |
|---|---|
| PostgreSQL instance | 52 migrations and a `vector` extension of its own; sharing a cluster couples two environments' availability |
| Redis instance | Delayed deliveries live there; a shared Redis means a staging flush destroys production's scheduled sends |
| `AUTH_SECRET` | A shared secret makes a staging session valid in production |
| `CHANNEL_CREDENTIAL_KEY` / `_KEY_ID` | Per `PILOT_READINESS_AUDIT.md` §3.3 these cannot be rotated, so they must be *right from the start* and must differ between environments |
| OAuth client | A separate Google client, so a staging redirect cannot be used against production |
| Meta assets | Test assets only |
| Client data | **No production client data in staging**, which is also a privacy obligation and not merely hygiene |

The current deployed instance satisfies none of these as a staging environment: it has placeholder Meta
credentials, no AI key, no payment provider, is six migrations behind this tip, and shares a host with
another product's production workload. It is a demonstration, and the audit treats it as one.

### A contradiction to resolve, not to paper over

`docs/specs/RELEASE_PROCESS.md` states that no staging environment exists. That is true of the repository
and false of the world. Either the deployed instance gets a real deployment contract in the repository
(`Dockerfile` and compose are deliberately outside it today, because the branch head was under review and
must not move), or it is retired and the statement becomes true again. **Owner decision**, recorded in
`PILOT_READINESS_AUDIT.md` §6.

## 2. Sequenced candidate follow-ups

The order is not a preference — items 1 and 2 are prerequisites for the pilot having any meaning, and
everything else is wasted if they are skipped.

### F1 — Make an approved draft actually send

**Highest priority. Must precede inviting any real business.**

| | |
|---|---|
| Scope | Close the gap in `PILOT_READINESS_AUDIT.md` §3.1: an approval or a human-composed reply must result in an enqueued delivery, or must fail loudly. Decide deliberately between enqueueing on the write path and adding a sweeper for `SCHEDULED` rows; a sweeper also repairs rows already orphaned, and the reliability metric at `packages/db/src/reliability-metrics.ts:84` already knows how to find them |
| Also in scope | The `composer-store.ts:71` consequence — an orphaned row must stop blocking further replies in that conversation |
| Evidence required | An integration test that starts from **approving a draft** and asserts a delivery job exists, not one that hand-builds the job literal and calls the handler. Plus a mutation check: break the enqueue and confirm the new test fails. The existing `review-delivery.integration.test.ts` passes today with the defect present, which is why a new test must begin one step earlier |
| Owner permission | A separate authorized code task. Not started from Issue #123 |
| Note | Until this is confirmed fixed, the owner's standing instruction holds: **no real business conversations in the pilot** |

### F2 — Operator bootstrap and the runbook that names it

| | |
|---|---|
| Scope | Document, and decide the mechanism for, creating the first `platform_members` row. One hand-written `INSERT` is sufficient and needs no code; a guarded bootstrap path is the alternative and does need code plus a decision about who may use it |
| Evidence required | A runbook step that a person who has never seen this repository can follow, ending in a verification that the kill switch is reachable from the UI |
| Owner permission | Approve the approach, and say who holds `PLATFORM_ADMIN` |
| Why it is second | The pilot's safety story is "a human can stop it instantly". Today nobody can |

### F3 — Enforce "invitation-only"

| | |
|---|---|
| Scope | The product does not enforce it at all (`PILOT_INTEGRATION_DEPENDENCY_MAP.md` §1); since #118 sign-in is public and self-serve. Choose one: keep the origin unpublished and accept the risk; an allowlist in front of sign-in; or admit accounts by hand with both providers disabled |
| Evidence required | For an allowlist: a test proving a non-listed address is refused **and** a control proving a listed one succeeds. A refusal test with no success control is the failure mode this project has hit before |
| Owner permission | Choose the approach — it is a product decision, not an implementation detail |

### F4 — An explicit server-side payment refusal

| | |
|---|---|
| Scope | Replace "payments are off because nobody configured them" with a stated, testable refusal, and align the UI so it does not render a path that cannot complete |
| Evidence required | A test that payment capture is refused **with** `STRIPE_ROUTES` present, which is the only configuration in which the current absence-based guarantee says nothing |
| Owner permission | Approve that this is wanted at all; the owner may prefer to rely on configuration during a short pilot |
| Can run in parallel | Yes |

### F5 — Observability a pilot operator can act on

| | |
|---|---|
| Scope | A readiness endpoint that reflects dependency state, rather than the current liveness probe that answers `ok` through a database outage; a scrapeable surface for the worker, which has none; and one path from a condition to a human |
| Evidence required | Stop PostgreSQL and show the readiness endpoint reporting unhealthy. Not a log line — a notification someone receives |
| Owner permission | Approve scope and the notification channel |

### F6 — Staging configuration and a real deployment contract

| | |
|---|---|
| Scope | §1 of this document: the separations, and bringing `Dockerfile`/compose into the repository with a documented deployment |
| Evidence required | A fresh environment brought up from the repository alone, with its migration count matching the tip — the current instance's 46 against the tip's 52 is exactly the drift this prevents |
| Owner permission | Approve the staging host and origin; approve retiring or documenting the current instance |

### F7 — The `FREE_BETA` pilot grant

| | |
|---|---|
| Scope | A narrowly scoped, owner-controlled, per-workspace, revocable grant with explicit expiry and extension. The constraints it must satisfy are enumerated in `PILOT_INTEGRATION_DEPENDENCY_MAP.md` §3 and are not re-litigated here |
| Prerequisite | **An ADR first if it needs a seventh subscription state**, because that changes core entity semantics, which `CLAUDE.md` places outside what may be decided without one |
| Evidence required | Tests that it creates no paid subscription, cannot re-open an expired trial, is revocable, and expires without manual intervention; plus a per-workspace cost bound, which does not exist today |
| Owner permission | Approve the design before implementation, since the shape is a product decision |

### F8 — Auth and Meta connectivity, end to end

| | |
|---|---|
| Scope | Supply and verify the values in `PILOT_INTEGRATION_DEPENDENCY_MAP.md` §2 and §4, and confirm the Human Agent attestation honestly |
| Evidence required | A real sign-in completed in a **browser**, and a real channel connected. Verified in a browser on more than one screen, because a status code and a byte count do not prove a page renders — this product has produced two healthy-looking HTTP exchanges over a page that would not display |
| Owner permission | Provider accounts and credentials are the owner's to create. This author must not provision accounts or real secrets |

### F9 — One end-to-end run, then a limited rollout

| | |
|---|---|
| Scope | One complete path: a message arrives, a draft is generated by a real provider, a human approves it in DRAFT mode, the customer receives it, and the audit trail shows each step. Then one invited business, watched, before any others |
| Prerequisite | F1, F2, F3, F8 |
| Evidence required | The run itself, with the delivery row reaching `SENT` and a recorded provider message id. No synthetic substitute counts: F1 exists precisely because a test that hand-built the job literal passed while the real path was broken |
| Owner permission | An explicit owner release decision. This is the step the whole audit exists to protect |

## 3. What stays out of scope until a separate owner decision

Commercial launch, Stripe onboarding for the Romanian company, paid subscriptions, publishing the legal
drafts, publishing the commercial catalogue, and unattended AUTOPILOT. The directive defers commercial
launch to its own decision, provisionally about a month later and explicitly not a committed date.

## 4. The honest summary

Three things are known: what a host must provide, what the deployed instance is and is not, and where the
product's gaps are. Two defects — F1 and F2 — mean the pilot as specified cannot run today: the mandated
DRAFT-first mode cannot deliver a reply, and nobody can reach the control that stops it.

That is the result an audit before launch is for. It was found before a real business was given the
service rather than after a customer complained.
