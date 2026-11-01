# Pilot Server Requirements

What a host must provide to run this product for an **invitation-only, free, real-business pilot**
(Issue #123). Every figure below is measured from the repository at the accepted tip
`855f7edaa07a916ec05fc5db00e18dee68047efb`; where a figure is not measurable from the repository it is
marked **UNKNOWN** rather than estimated.

This document contains **no host addresses, credentials, tokens or machine-specific inventory** — only
requirements and environment variable *names*. It is written to be safe to read and to share.

## 0. What this document cannot tell you

The production host's specifications have not been provided. This document therefore states what the
software *requires*, and `PILOT_HOST_INVENTORY_CHECKLIST.md` states how to collect what a candidate
host *offers*. Comparing the two is a separate decision that needs the host data.

Specifically **UNKNOWN**, and not to be guessed: CPU model and core count, RAM, disk type and size,
IOPS, operating system and version, kernel, provider, region, network egress limits, existing workloads
on the host, and whether DNS and TLS for the intended origin are configured.

## 1. Runtime

| Requirement | Value | Where this is fixed |
|---|---|---|
| Node.js | **24.x** | `.nvmrc`; `devEngines.runtime ^24.0.0` with `onFail: "error"` makes pnpm **refuse to install** on another major |
| Package manager | **pnpm 12**, via Corepack | root `package.json` `packageManager` |
| TypeScript | 6.0 (not 7) | native TS is not yet supported by `typescript-eslint` type-aware linting |
| Web framework | Next.js 16 / React 19 | built with Turbopack |
| Worker | esbuild single-file bundle | `apps/worker`, production runs the bundle, not `tsx` |

`engineStrict` is on, and dependency lifecycle scripts are blocked unless listed under `allowBuilds` in
`pnpm-workspace.yaml`. A host whose Node major differs cannot install dependencies at all — this fails
closed, early and loudly, which is the intended behaviour.

## 2. Long-running processes

The host must keep **two** processes alive, independently supervised:

1. **web** — the Next.js server. Serves the dashboard, the API, the OAuth callbacks and the provider
   webhooks.
2. **worker** — long-running processors. Not a cron job: it runs its own internal loops.

Nine loops start inside the worker (the registry is built from what actually started, not from a
hand-written list):

`outbox`, `reconciliation`, `retention`, `usage_reservations`, `checkout_expiry`,
`instagram_tokens` *(only where token refresh is configured)*, `follow_ups`, `backlog_guard`, `health`.

Consequences for the host:
- there is **no external scheduler** to install — no cron entries, no systemd timers for product work;
- the worker must be restarted gracefully, and it handles its own shutdown: each loop holds a database
  or Redis handle and is closed before the connections are;
- killing the worker hard can leave work in flight. Delayed deliveries survive because they live in
  Redis with append-only persistence (see §4), not because the process remembers them.

## 3. PostgreSQL

| Requirement | Value |
|---|---|
| Major version | **17** |
| Required extension | **`vector`** (pgvector) — `CREATE EXTENSION IF NOT EXISTS vector` |
| Migrations to apply | **52** |
| Models in the schema | **75** (`schema.prisma`, 3 187 lines) |
| Vector columns | `knowledge_chunks.embedding`, `style_examples.embedding`, both `vector(1024)` |
| Lexical search | GIN expression indexes on `to_tsvector('simple', …)` |

**PostgreSQL 16 is not sufficient**, and an existing 16 instance on a candidate host cannot be reused
for this schema. The embedding dimension is fixed in the column type, so changing the embedding model
to one with a different dimension is a migration, not a configuration change
(`AI_EMBEDDING_DIMENSIONS` defaults to `1024` and must agree with the column).

**There is no `hnsw` or `ivfflat` index on either vector column** — verified across all 52 migrations,
with a positive control confirming the same search does find the GIN indexes that do exist. Similarity
search is therefore a sequential scan. For an invitation-only pilot with a small knowledge base this is
acceptable and costs nothing; it is a scaling item to revisit before a public launch, not a pilot
blocker. Size the database for *correctness and backup*, not for vector-index memory.

A second database is needed only for development and CI (`SHADOW_DATABASE_URL` for drift checking,
`TEST_DATABASE_URL` for integration tests). A production host does **not** need them.

## 4. Redis

| Requirement | Value |
|---|---|
| Version | **7.x** |
| Persistence | **append-only must be on** (`--appendonly yes`) |

Append-only is not a performance preference. Delayed and scheduled deliveries live in Redis, and the
product's randomized delayed delivery depends on them surviving a restart. A Redis configured without
persistence, or flushed, silently loses scheduled sends.

## 5. Object storage

**Not required.** No object-storage SDK appears in any `package.json` — checked by dependency, not by
substring, with a positive control against a dependency that is present. Media bytes are fetched from
the provider on demand and are not persisted to a bucket; the schema records when the provider deleted
the raw media at its end, which is the retention hook's record.

Note the divergence: `docs/specs/LAUNCH_READINESS.md` §2 lists object storage among the things a
production-like staging environment should have. That is a spec expectation with no implementation
behind it today. For the pilot there is nothing to provision; for a later launch the spec and the
implementation need reconciling.

## 6. HTTPS, origin and reverse proxy

The intended app origin is `https://mixamart.com`. **No claim is made here that DNS, TLS or the service
are configured or reachable.**

HTTPS is a functional requirement, not a hardening preference:

- `AUTH_URL` is the one origin from which callbacks and emailed sign-in links are built, and **no
  request header substitutes for it**. Without it, every sign-in method is withheld with reason
  `NO_BASE_URL`.
- An `AUTH_URL` that is plain HTTP outside development withholds sign-in with reason
  `INSECURE_BASE_URL` — a link and a session cookie would otherwise travel in the clear.
- `INSTAGRAM_REDIRECT_URI` must be HTTPS and must match the value registered with Meta exactly.
- The domain hosting WhatsApp Embedded Signup must be HTTPS and listed in the Meta app's Allowed
  Domains and Valid OAuth Redirect URIs.

### Two reverse-proxy settings that have already produced a false "it works"

Both were observed on a real deployment of this product, and both produce a perfectly healthy HTTP
exchange while a browser shows an error or hangs:

1. **`default_type`.** nginx serves `return 403 "text"` as `application/octet-stream`, which Chrome
   refuses to render at all, while `curl` prints the body and looks fine. Set
   `default_type text/html; charset utf-8;` and return real HTML from any proxy-level refusal.
2. **`Connection: upgrade` set unconditionally**, copied from a websocket recipe without its
   `map $http_upgrade $connection_upgrade { default upgrade; '' close; }`, combined with nginx's
   default response buffering. The Next.js App Router streams its payload, so the browser sits on the
   Suspense fallback indefinitely while `curl` reports `200` and a full body. Add the map and set
   `proxy_buffering off`.

The operational rule this implies: **a status code and a byte count do not prove that a page renders.**
Verification of a browser-facing deployment must happen in a browser, on more than one screen — the
root page worked while the Inbox hung.

If a trusted proxy sits in front of the app, `AUTH_TRUSTED_CLIENT_IP_HEADER` names the header the rate
limiter should read. The proxy must **overwrite** that header rather than append to it; a client-supplied
value would otherwise let a caller choose its own rate-limit identity.

## 7. Environment variables — names only

No values appear here. Required means: the schema gives it neither a default nor `optional()`, so the
process will not boot without it.

**`apps/web` — 8 required:** `DATABASE_URL`, `AUTH_SECRET`, `REDIS_URL`,
`CHANNEL_CREDENTIAL_KEY_ID`, `CHANNEL_CREDENTIAL_KEY`, `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`,
`INSTAGRAM_REDIRECT_URI`.

**`apps/worker` — 3 required:** `DATABASE_URL`, `REDIS_URL`, `ANTHROPIC_API_KEY`.

Optional, and each one gates a specific capability rather than boot:

| Names | What is withheld without them |
|---|---|
| `AUTH_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `AUTH_EMAIL_FROM`, `AUTH_EMAIL_SERVER` | Sign-in. Each method is offered only when **fully** configured; a half-configured method is reported as withheld with a reason rather than rendered as a button that fails out of sight. |
| `AUTH_TRUSTED_CLIENT_IP_HEADER` | Correct client identity for the rate limiter behind a proxy. |
| `STRIPE_ROUTES`, `BILLING_RETURN_BASE_URL` | Billing routing and checkout return. **Both must stay absent for the free pilot** — see §8. |
| `VOYAGE_API_KEY`, `AI_EMBEDDING_MODEL`, `AI_EMBEDDING_DIMENSIONS`, `AI_EMBEDDING_REVISION` | Semantic retrieval. Absence is supported and honest: retrieval runs lexical-only. |
| `AI_REPLY_MODEL`, `AI_REPLY_MAX_OUTPUT_TOKENS`, `AI_PERSONA`, `AI_REPLY_TIMEOUT_MS` | Have defaults; they are deployment configuration, changed here rather than in code. |
| `INSTAGRAM_VERIFY_TOKEN`, `WHATSAPP_VERIFY_TOKEN` | Webhook verification. |
| `WHATSAPP_APP_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_SIGNUP_CONFIG_ID` | WhatsApp onboarding. All three are optional together, and without them the connect endpoints refuse with `not_configured` instead of starting a flow that cannot be finished. |
| `WHATSAPP_GRAPH_VERSION` | Graph API version for onboarding calls — a deployment default, not a constant of the code. Embedded Signup v2 and v3 were retired 2026-10-15; this implementation targets v4. |
| `INSTAGRAM_HUMAN_AGENT_APPROVAL` | Set to `APPROVED` only after Meta has approved the Human Agent feature. **No API reports this**, so it is an operator attestation. |
| `LOG_LEVEL`, `NODE_ENV`, `WORKER_CONCURRENCY`, `WEBHOOK_BASE_URL` | Operational tuning. |

Secrets to generate per environment, never shared between environments: `AUTH_SECRET` and
`CHANNEL_CREDENTIAL_KEY` (≥32 bytes each). `CHANNEL_CREDENTIAL_KEY_ID` changes on rotation, and stored
rows record the key id they were written with, so an old row stays readable after a rotation.

## 8. The free pilot's hard constraint on payments

The directive requires that Stripe, PayPal, checkout, paid subscriptions, real charging, automatic
invoices and all payment capture be **disabled** for the pilot, and that the disable hold at **UI and
server**. Two consequences for the host configuration:

- `STRIPE_ROUTES` and `BILLING_RETURN_BASE_URL` must be **absent** from the environment.
- Absence of configuration is a necessary condition, not a sufficient one. Whether an explicit
  server-side disable exists today is assessed in `PILOT_READINESS_AUDIT.md`; this document does not
  claim one exists.

## 9. What the product does *not* need from the host

Stated explicitly, because each one is a cost a host sizing exercise might otherwise assume:

- no object storage or S3-compatible bucket (§5);
- no external scheduler, cron or queue service beyond Redis (§2);
- no second PostgreSQL instance in production (§3);
- no vector-index memory budget, because no vector index exists (§3);
- no container registry — the worker ships as a single bundled file;
- no Kubernetes; two supervised processes behind a reverse proxy is the whole topology.

## 10. Sizing

**UNKNOWN, and deliberately not estimated.** The repository fixes versions and topology; it does not
establish how much CPU, memory or disk a real pilot workload needs. No load test exists, and the one
deployment of this product that has run was configured with its AI path disabled, so its observed
footprint is not evidence about a working pilot.

What *can* be said without inventing numbers:
- the peak memory moment is the **build**, not the steady state: a Next.js 16 Turbopack build plus an
  esbuild worker bundle. Building on a small host is the usual first failure;
- steady-state memory is dominated by two Node processes plus PostgreSQL's own buffers;
- the database grows with conversations, audit events and knowledge chunks. `audit_events` is
  append-only and has a GIN index on its summary, so it grows faster than conversation volume alone
  would suggest;
- there is no vector index to hold in memory (§3);
- AI provider cost is per-message and does not scale with the host.

To turn this into a decision, collect the host's actual figures with
`PILOT_HOST_INVENTORY_CHECKLIST.md` and record them **privately**, outside this repository.
