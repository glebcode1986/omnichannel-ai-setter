# Pilot Readiness Audit

Issue #123. Audited at the accepted tip `855f7edaa07a916ec05fc5db00e18dee68047efb` (PR #122 head).
**This is an audit, not a release approval.** Nothing here claims the product is deployed or ready to
invite customers.

## 0. Preconditions, verified live before the audit began

| Check | Result |
|---|---|
| PR #122 live head equals the directive's `accepted_parent_head` | yes, `855f7eda…` |
| PR #122 state | `open`, non-draft, unmerged, `mergeable_state=clean` |
| Formal verdict bound by REST `commit_id` to that head | review `5717125714`, `APPROVED` |
| A newer accepted tip that supersedes it | none — all 56 open PRs polled, zero verdicts after `2026-10-30T18:44:21Z` |
| This branch contains the accepted head | `git merge-base --is-ancestor` → yes |

One method note that matters for anyone repeating this. The verdict body holds **two** marker lines: the
verdict at the top, and `ANTIGRAVITY_REVIEW: PASS head=74f6bbd0…` further down inside the ancestry
evidence — which is **#120's** head, quoted. Selecting the last marker reads the verdict as covering the
predecessor. The only binding is the review object's `commit_id`; pick the body marker whose `head=`
equals it, never by position.

## 1. How to read the provenance of each finding

This audit mixes work done directly and work done by three parallel evidence agents. The distinction is
recorded because it changes how much weight a reader should give a claim:

- **verified here** — re-derived independently, with the command or file:line stated.
- **probe** — established by a purpose-written script that was run, with a positive control.
- **agent evidence** — measured by an evidence agent and not independently re-derived.

Two agent claims were **refuted** on re-derivation and are recorded as such in §2. Treating an agent's
confident absence claim as fact is the specific mistake this section exists to prevent.

## 2. Corrections to the evidence gathered

**Refuted: "there is no health endpoint a host could scrape."** `apps/web/src/app/api/health/route.ts`
exists. The substance survives in a narrower form, which is what §4 records: it is a **liveness** probe
that deliberately touches no database, queue or external API, so it answers `{"status":"ok"}` through a
total PostgreSQL outage.

**Refined: "nothing in production can create a `platform_members` row."** A production writer does exist
— `packages/db/src/support-access-store.ts:355`. But its first statement is
`requirePlatformPermission(context, "MANAGE_PLATFORM_MEMBERS", …)`, a permission only `PLATFORM_ADMIN`
holds. So the precise claim is that **the first** row cannot be created through the product, which is a
bootstrap deadlock rather than a missing feature. Verified here.

**Stale: "the host documents are untracked and therefore invisible on GitHub."** True when the agent
sampled the tree; resolved before this document was written. Both are committed on this branch and open
as PR #124.

## 3. BLOCKERS

### 3.1 An approved draft is never sent — and the pilot is mandated to start DRAFT-first

**Verified here.** Approving a draft (`packages/db/src/review-store.ts:134`) and composing a human reply
(`packages/db/src/composer-store.ts:89`) each write a `delivery_jobs` row with `status: "SCHEDULED"`.
Nothing enqueues a delivery job for it:

- the only two production enqueues are `apps/worker/src/draft-disposition.ts:299` (the AUTOPILOT path)
  and `apps/worker/src/reconcile-handler.ts:82` (resume after reconciliation);
- the reconciliation sweeper's selection, `findUnresolvedOperations`
  (`packages/db/src/reconciliation-store.ts:256`), takes `deliveryReconciliation` rows in `UNRESOLVED`
  plus `delivery_jobs` with **`status: "HELD_AMBIGUOUS"` and no reconciliation row**. It never selects
  `SCHEDULED`;
- the application-layer review dependencies are `{reviews, style, log, now, inboundContextFor}` — there
  is no queue port on that path at all.

The UI reports success. So in DRAFT mode a human approves a reply, is told it was sent, and the customer
receives nothing.

Two second-order effects, both verified here:

- `packages/db/src/composer-store.ts:71` treats a `SCHEDULED` row as "a reply is already in flight", so
  an orphaned row **permanently blocks composing another reply in that conversation**. The operator is
  stuck with no way to retry.
- the condition is not entirely invisible: `packages/db/src/reliability-metrics.ts:84` finds the oldest
  overdue `SCHEDULED` delivery. It is a metric, not a recovery — and it is only visible to someone who
  can reach the admin console, which §3.2 shows nobody can on day one.

**Why no gate caught it.** `apps/worker/src/review-delivery.integration.test.ts` hand-builds the
`DeliveryJob` literal and calls the delivery handler directly, so it proves the handler works when
given a job. Nothing asserts that approving a draft produces one. This is the project's recurring defect
class — correct pieces with no path between them — in its purest form.

**Live confirmation that the path has never run.** The deployed instance has `0` rows in
`delivery_jobs`, with 6 conversations and 9 messages, and its AI provider key is absent. The defect was
never going to surface there.

**Scope.** Fixing this is code, and Issue #123 is docs-only. It is listed in the plan as the
highest-priority separately-authorized follow-up, and it must precede inviting any real business.

### 3.2 Nobody can operate a fresh deployment

**Verified here.** The kill switch, the entire `/admin` console and both release commands authorize
through a `platform_members` row, and the only production writer of that table requires
`MANAGE_PLATFORM_MEMBERS`, which only `PLATFORM_ADMIN` holds. The first row cannot be created through
the product.

For a free pilot this is worse than for a paid launch, because the pilot's whole safety story is "a
human can stop it instantly". On day one, nobody can pull that lever through the product.

The remedy costs no code — one hand-written `INSERT` for the owner's user id — but it is **undocumented**,
which is why it will not happen unless it is written into a runbook before the first business is invited.

### 3.3 Rotating the credential key bricks every connected channel

**Probe, with a positive control.** The cipher accepts a map of keys by id, and supplying a retired key
beside the current one decrypts an old row — that is the control. But all five production composition
sites build that map as a single entry keyed by the current id
(`apps/web/src/server/credential-cipher.ts:16`, `apps/worker/src/delivery-engine.ts:55`,
`apps/worker/src/instagram-token-sweeper.ts:133`, `apps/worker/src/media-port.ts:39`,
`apps/worker/src/presence-port.ts:27`), and no environment variable exists for a second key. Rotation
makes every stored provider credential permanently undecryptable, surfacing as an uncaught job error
rather than a startup refusal.

This document's own earlier revision asserted the opposite. The correction is recorded in
`PILOT_SERVER_REQUIREMENTS.md` §7 rather than silently edited away.

**Pilot consequence:** choose the two values once, back them up *with* the database, and treat rotation
as blocked work. A database restore without the matching key leaves every channel unusable.

### 3.4 Redis durability is assumed, never verified, and loss is unrecoverable

**Agent evidence, spot-checked here.** Append-only persistence is the only thing protecting in-flight
work, and nothing verifies it:

- the expectation appears only in `compose.yaml:20-21` and `docs/specs/DELAY_ENGINE.md:82`;
- CI runs a bare `redis:7-alpine` with no `--appendonly` (`.github/workflows/verify.yml:60-67`), so
  `pnpm test:redis` and `pnpm test:e2e` exercise a Redis without AOF — the durability expectation is
  never tested;
- the runtime probe is `status !== "ready"` then `ping()` (`apps/worker/src/health-probes.ts:33-46`) —
  no persistence check;
- the one test that mentions a restart opens a fresh *connection* while the same Redis stays up.

A flush or a non-persistent Redis silently destroys debounce timers, transcription jobs, presence jobs
and delayed deliveries, and there is no database-side recovery: a dispatched outbox entry is never
re-claimed (`claimOutboxEntries` requires `dispatchedAt: null`), and per §3.1 there is no sweeper for
`SCHEDULED` rows.

### 3.5 Monitoring tells an operator nothing, and nothing alerts a human

**Verified here** for the endpoint, **agent evidence** for the rest. `/api/health` is a liveness probe
that touches nothing, so a monitor scraping it reports green through a total database outage. The worker
exposes no HTTP surface at all. The product emits structured log lines and audit events; nothing turns a
condition into a notification. "Emits a log line" and "alerts a human" are different capabilities, and
only the first exists.

### 3.6 Backup and restore

**Agent evidence.** The repository implements nothing. This is entirely a host question, and the one
question that matters is whether a restore has ever been performed — an untested backup is a plan, not a
capability. Combined with §3.3, a restore also needs the credential key preserved alongside it.

### 3.7 Billing: what the hard-disable actually rests on

The directive requires payment capture disabled at **UI and server**.

**Server side — PASS.** With `STRIPE_ROUTES` absent, `apps/web/src/server/billing-adapters.ts:38-40`
registers no adapter and logs `billing.adapter_unconfigured`. The worker and queue surface contain no
Stripe or PayPal reference at all. An adapter that could reach the database is forbidden by the
dependency matrix precisely so that a paid entitlement cannot be activated without a verified provider
event.

**But the disable is an absence, not a decision — BLOCKER.** There is no flag, no policy and no
environment variable that *says* "payments are off for the pilot". The guarantee is that nobody
configures `STRIPE_ROUTES`. That is a correct outcome resting on an omission, which is exactly the shape
that regresses the first time someone sets a variable to test something. The pilot needs an explicit,
testable server-side refusal, and that is code.

**UI side — GAP.** Plan and checkout affordances are rendered from the catalogue, not from adapter
availability, so a pilot operator can still be shown a path that cannot complete. `billing.offerExplains`
promises "Nothing is deleted when you move. You choose what stays active." and no selection screen
exists behind it (`apps/web/src/ui/billing/plan-offers.tsx:94`; the only test asserts the text is
present).

## 4. GAPS worth naming for the pilot

| Area | Finding | Pilot impact |
|---|---|---|
| DRAFT-first enforcement | New profiles start `OFF`, so nothing auto-sends on day one. But with no release recorded the rollout gate is permissive, so a pilot business flipping its own profile to AUTOPILOT is not refused platform-side — and the lever that would refuse is behind §3.2 | Not an immediate blocker; becomes one the moment a business explores settings |
| Instagram credentials mandatory to boot | `apps/web` cannot start without `INSTAGRAM_APP_ID/SECRET/REDIRECT_URI`, so a WhatsApp-only or no-channel pilot must still supply placeholders | Operational nuisance that invites fake values into production config |
| Vector similarity search | No `hnsw`/`ivfflat` index on either `vector(1024)` column, across all 52 migrations, with a positive control on the GIN indexes that exist | Fine at pilot scale; a scaling item, and **not** a memory budget to provision |
| Worker concurrency | No environment variable bounds it, though `packages/queue/src/families.ts:164` claims "every one of them is overridable from the environment" and the composition root passes neither `limits` nor `concurrency` | A small host cannot be protected by configuration. The comment is the defect |
| AI spend per workspace | Agent evidence: no per-workspace spend ceiling | Cost exposure in a free pilot is unbounded by the product |
| Security response headers | Agent evidence: none set | Cheap to add at the reverse proxy |
| Tenancy on workspace-wide tables | Agent evidence: guarded by role only, not by a scope column | Reviewed previously; bounded |
| `worker.started` loop registry | Agent evidence: a gap in what it reports | Low |
| Trusted-proxy documentation | Agent evidence: doc contradicts code | Resolve with the contradictions in §6 |

## 5. The documented release gaps, classified

`docs/specs/RELEASE_PROCESS.md:98` already admits that §2 staging and §14 booking have nothing automated
at all. Classified for an **invitation-only free pilot**, which is a different question from a paid
launch:

| Documented gap | Classification | Why |
|---|---|---|
| No staging environment exists | **Bounded pilot-only limitation** | The pilot is invitation-only and reversible; a dedicated staging instance is required before paid launch, not before a handful of invited businesses — provided §3.1 and §3.2 are fixed first |
| `pnpm evals` not run by CI | **Bounded, with a named mitigation** | The suite passes 20/20 and the reviewer runs it on every head. The mitigation is that this is the *only* reason it runs; if the reviewer stops, the gate disappears. The fix is a one-step workflow change the owner must apply (§6) |
| Observability and runbooks | **BLOCKER** | Not because of the documents, but because of §3.2 and §3.5: an operator who cannot reach the kill switch and cannot be alerted has no way to stop a bad outcome for a real business |
| No end-to-end unattended worker/runtime evidence | **BLOCKER** | §3.1 is exactly what that missing evidence would have caught |
| Safe default when no release is recorded | **BLOCKER for AUTOPILOT, bounded for DRAFT** | The gate returns permissive with nothing recorded. Harmless while every profile is `OFF`/`DRAFT`; wrong the moment one is not |
| Feature-flag limitations | **Bounded** | Acceptable at pilot scale with the pilot grant owner-controlled |
| §14 booking | **Not applicable** | Out of pilot scope |

## 6. Documentation contradictions found, and their disposition

The owner asked for these to be resolved. Each is recorded with what was done, because three of them
require a decision that is not this task's to make.

| Contradiction | Disposition |
|---|---|
| `PILOT_SERVER_REQUIREMENTS.md` §7 listed `WORKER_CONCURRENCY` and `WEBHOOK_BASE_URL` as environment variables. They exist nowhere outside a test fixture | **Fixed in this PR**, and replaced with the true statement that no such knob exists |
| The same §7 said a stored credential row stays readable after key rotation | **Fixed in this PR** (§3.3), with the correction stated rather than silently removed |
| The same document asserted "PostgreSQL 16 is not sufficient" | **Fixed in this PR**: 17 is the tested configuration; all 52 migrations were scanned for version-gated syntax and none appears, so 16 is untested rather than known-broken. The host conclusion is re-grounded on not sharing another workload's cluster |
| `docs/handoff/ci-evals-step.patch` instructs `git apply` and does not apply (`git apply --check` → exit 128, `No valid patches in input`): the `@@` header carries no line numbers and a prose preamble precedes the diff | **Fixed in this PR** — the patch now applies cleanly, verified by `git apply --check` exiting 0. Applying it still requires the owner, because this author cannot push `.github/workflows` |
| `packages/queue/src/families.ts:164` claims concurrency is environment-overridable; it is not | **Recorded, not fixed.** The fix is a code or comment change and this task is docs-only |
| `LAUNCH_READINESS.md` §2 lists object storage among a staging environment's parts; no implementation exists and none is needed | **Recorded, needs an owner decision**: either the spec drops the expectation or a later phase implements it. Changing a spec's substance is a product call |
| `RELEASE_PROCESS.md` states "no staging environment exists" while an undocumented instance is deployed | **Recorded, needs an owner decision.** The statement is true of the repository and false of the world. Resolving it means either documenting the instance with a real deployment contract or retiring it |
| Trusted-proxy documentation disagrees with the code | **Recorded**, agent evidence, not independently re-derived |

## 7. What the owner must decide

1. **Authorize the §3.1 delivery fix as the next task**, before any real business is invited. It is the
   one defect that makes the mandated DRAFT-first mode non-functional.
2. **The operator bootstrap (§3.2)**: approve writing the one-row `INSERT` into a runbook, and say who
   holds `PLATFORM_ADMIN`.
3. **An explicit server-side payment refusal (§3.7)** rather than relying on an unset variable — yes or
   no, and if yes it is a separate code task.
4. **The `FREE_BETA` grant** remains UNKNOWN in implementation terms and is deliberately not designed
   here; the constraints it must satisfy are in `PILOT_IMPLEMENTATION_PLAN.md`.
5. **Object storage and the staging statement** (§6) — which way each spec should move.
6. **Apply the corrected CI evals patch**, which only the owner can push.

## 8. What this audit does not establish

- That the product works end to end. No run exists in which a message arrived, a draft was generated by
  a real provider, a human approved it and a customer received it. §3.1 says why that run would have
  failed.
- That any host is adequate. Sizing is `UNKNOWN`; see `PILOT_SERVER_REQUIREMENTS.md` §10.
- That the deployed instance is relevant evidence. It is 6 migrations behind this tip, its AI, channel
  and payment paths are disabled by absent keys, and it has never dispatched a delivery.
- That the pilot may begin. It may not, on the strength of §3.1 and §3.2 alone.
