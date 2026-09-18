# Current Handoff

**Last updated:** 2026-09-18  
**Repository:** `glebcode1986/omnichannel-ai-setter`  
**Current stage:** Stage B — Instagram + shared AI implementation  
**Immediate independent-review gate:** PR #50 / P1-03  
**Next implementation target after pending follow-ups:** Issue #13 / P2-06 Delivery Coordinator

> **START HERE in a new ChatGPT/Claude/Astra session.**  
> GitHub is the canonical project memory. Chat history is not an execution contract.

## Read order for a new session

1. `PROJECT_CONTEXT.md`
2. **this file**
3. `AGENTS.md`
4. `CLAUDE.md`
5. `docs/tasks/CLAUDE_EXECUTION_QUEUE.md`
6. Master Issue **#61**
7. exact issue / PR / task contract currently being worked
8. relevant canonical specs/ADRs

Before making any exact-state claim, fetch live PR HEADs. The SHA table below is a dated snapshot and will move.

---

## Executive state

The project is no longer in architecture-only mode. Real implementation is active.

Completed/implemented in the current stacked train:
- Phase 1 scaffold/domain/DB/queue/webhook ingestion;
- Business Profile v0.4 propagation through domain, persistence, jobs and ingestion;
- Instagram transport adapter;
- Instagram Login onboarding/token lifecycle;
- provider-neutral AI draft engine;
- factual + style retrieval;
- deterministic policy engine.

Still ahead on the Commercial Beta critical path:
- delivery coordinator;
- human handoff/review runtime;
- evals + Instagram E2E;
- reliability/kill switches;
- SaaS UI;
- WhatsApp;
- privacy/deletion;
- billing/entitlements;
- Admin Operations;
- launch-readiness gate.

Design principle remains: **design broadly, implement narrowly**.

---

## Current stacked implementation — live snapshot 2026-09-18

Independent review must proceed in dependency order.

| PR | Task | Current HEAD snapshot | Review state |
|---|---|---|---|
| #49 | P1-02 domain/channel contracts | `34a71d0d36b04f2c8933aa29479e26cbc87e7800` | Astra PASS |
| #50 | P1-03 Prisma/Auth/BP isolation | `a3eebd62c5ee0d2e80b053ace43549425a08d6e6` | **Astra CHANGES_REQUESTED** |
| #51 | P1-04 BullMQ | `f45bb14aa14929696a07e00a6b3ebd1664191fd0` | queued behind #50 |
| #52 | P1-05 webhook ingestion | `9533b0a2a2fb26591d976788d45521cefbd6d717` | queued behind #50 |
| #63 | P2-01 Instagram adapter | `2d7bcd768ea96ee91e532e7a772408970b89b559` | queued |
| #64 | P2-02 Instagram onboarding/tokens | `ac318f34ed3dc9f3b962174250fbeb0aa4ddeaf8` | queued |
| #65 | P2-03 AI draft engine | `d58ada0d57f730f7ea26517f2db30f988d55bbdd` | queued + owner follow-up pending |
| #66 | P2-04 retrieval | `c6972c7212792f68b8538e3cecddbc29cd542602` | queued + owner follow-up pending |
| #67 | P2-05 policy engine | `015433c33bf02efb865248ed03c06784f87158a5` | queued + owner follow-up pending |

All child updates above were propagated with normal merge commits. Do not rebase/force-push published stack branches merely to simplify history.

---

## Immediate blocker — PR #50 third Astra review

### Production bug that was found
Concurrent inbound appends could regress `Conversation.lastInboundAt` / `lastMessageAt`: an older message transaction could commit after a newer one and overwrite the timestamp backwards.

### Production correction
Claude added a fully scoped `SELECT ... FOR UPDATE` before reading the Conversation row and holds that lock through message insertion + timestamp/state-version update.

Astra's later reviews have **not** challenged the production row-lock fix itself. The remaining blocker is verification quality.

### What Astra still requires at current HEAD `a3eebd62...`
The forced PostgreSQL schedule currently uses a synthetic holder-side Conversation `UPDATE` that increments `state_version` but does **not** persist the corresponding newer inbound Message.

Therefore it does not yet prove the required invariant in the same forced interleaving:

- exactly two real inbound Message rows persist;
- `state_version` advances exactly +2;
- `last_inbound_at` equals the newer message timestamp;
- `last_message_at` equals the newer message timestamp;
- include explicit `lastInboundAt = NULL` setup;
- keep the PostgreSQL-observed lock-wait barrier;
- mutation/no-lock version must fail deterministically.

### Next Claude action
Fix only the regression harness/evidence unless a new production defect is discovered.

Preferred faithful test shape:
1. third/control connection acquires/holds the scoped row lock;
2. holder side represents a **real newer inbound append** — either a paused repository transaction or equivalent faithful SQL that inserts the newer Message and performs the same Conversation state transition in one transaction;
3. start the older repository append on an independent client;
4. verify via PostgreSQL `pg_stat_activity` / `pg_locks` that the older append is actually waiting;
5. release/commit the newer side;
6. assert exact two new message rows, stateVersion +2 and timestamp maxima;
7. repeat with a fresh conversation whose `lastInboundAt` is NULL.

Then publish a new exact marker:

`CLAUDE_READY_FOR_ASTRA head=<new-full-sha> task=P1-03`

and propagate the new parent normally down #51 -> #52 -> #63 -> #64 -> #65 -> #66 -> #67 (and any newer child PRs).

### Astra action
Do **not** accept downstream PRs before #50. Re-review the new exact #50 HEAD first. If PASS, continue in strict dependency order.

---

## CI / GitHub Actions status

Issue #37 / PR #62 is no longer blocked by workflow-file permission.

The active workflow now exists at:

`.github/workflows/verify.yml`

on branch `ci/p1-infra-verify-gate`.

Current PR #62 snapshot HEAD: `d889a1d5dafe7718e07c980aa3ce267b60fb344b`.

The workflow runs:
- root `pnpm verify`;
- PostgreSQL 17 via `pgvector/pgvector:pg17`;
- schema/migration drift;
- DB suites;
- Redis suites;
- worker E2E.

Neutral GitHub Actions run for exact PR #62 HEAD `d889a1d5dafe7718e07c980aa3ce267b60fb344b` completed **SUCCESS**: run `35383957555`.

Important nuance: PR #62 is a separate stacked CI branch. Do not claim that a PR #50 exact HEAD has neutral CI evidence unless the workflow actually ran against that exact code/ref. Integrate/propagate the CI gate into the active stack in a dependency-safe way before relying on it as exact-SHA release evidence.

---

## Product-owner decisions accepted on 2026-09-18

These are canonical and already recorded in specs on `docs/phase6-commercial-billing`.

### Instagram Human Agent
- remains an Instagram-specific explicitly-human capability/path;
- shared automated `ChannelAdapter` is not widened just for the Meta tag;
- AUTOPILOT/background workers never attach `HUMAN_AGENT`;
- eligibility is revalidated at the explicit human send.

### Instagram timing
- provider policy wins over generic “human-like” delay;
- current verified baseline: automated response budget 30s, operational target about 25s;
- debounce + generation + artificial delay share one total budget;
- artificial delay shrinks to zero when required;
- missed provider deadline -> hold/re-evaluate, never blindly send late;
- exact Meta rule must be re-verified during App Review/live integration.

### OFF mode
`OFF` disables background AI generation and all automatic scheduling/sending.

An authorized human **may explicitly request** `Generate draft / Ask AI` while OFF:
- this must be represented as an explicit human trigger/source;
- it never auto-sends;
- no follow-up/autopilot is enabled by that request;
- invocation is auditable.

### Business persona / StyleProfile
Business persona is customer-owned configuration, not worker environment configuration.

Resolution:
1. Workspace base StyleProfile;
2. Business Profile override;
3. allowed conversation-level downward/temporary overrides;
4. generic platform fallback only if no customer-owned style exists.

`AI_PERSONA` may be a temporary safe default, not tenant/BP authority.

### Knowledge / Style before Phase 5 UI
Do not pull the full customer editing UI into Phase 2.

Add only a minimal internal/dev/test seeding path so #16/CI can exercise:
- trusted versioned Knowledge with provenance;
- approved Style data;
- normal Workspace/BP authorization boundaries.

### Knowledge precedence
Retrieve Workspace base + BP-specific Knowledge.

BP-specific material is an authority override only when the relationship is **explicitly represented** (override/supersession/logical key). Do not infer conflicts or overrides from semantic similarity.

### Style language
Style examples should carry optional normalized language/locale metadata (BCP-47-compatible). Matching language is preferred; NULL is a language-agnostic fallback.

### Embeddings
Voyage/semantic retrieval is degradable:
- missing/unavailable embeddings do not stop worker/inbound;
- run lexical-only;
- expose degraded diagnostics/health;
- never turn retrieval degradation into invented factual certainty.

### Instagram STANDARD_ONLY after window
Closed standard window -> routine automatic work returns `SKIP`, not a normal Review item.

Inbox still shows the inbound message and operational state such as “window closed / AI could not send.” Separate incidents or explicit human actions may create Review.

### Quiet hours
Quiet hours defer only when a future `notBefore/deferUntil` still fits inside channel/provider eligibility.

If deferral would cross provider eligibility/deadline:
- do not send late;
- use HOLD_REVIEW or the channel-specific safe terminal result.

### Channel policy model
Use a discriminated per-channel after-window policy input now. Do not bolt WhatsApp onto a flat Instagram-only field later.

---

## Owner-decision follow-ups still pending in implementation

Before/while starting #13, Claude must apply the already-posted focused follow-ups:

### PR #65
- explicit human-requested draft allowed in OFF;
- explicit trigger/source so background work cannot impersonate human intent;
- consume resolved customer-owned StyleProfile rather than tenant persona from worker env.

### PR #66
- minimal internal/dev/test Knowledge+Style seed path;
- explicit override semantics only; no semantic shadow guessing;
- optional StyleExample language/locale;
- embeddings remain safe lexical-only degradation.

### PR #67
- STANDARD_ONLY closed window -> SKIP;
- quiet-hours safe deferral vs hold if provider deadline would be missed;
- channel-discriminated after-window policy input;
- OFF manual-assist never becomes automatic scheduling.

Propagate each focused correction down the stack normally and update exact HEAD markers.

---

## Next implementation sequence

After the #65/#66/#67 owner follow-ups, continue MASTER #61:

### Stage B — Instagram + shared AI
- ✅ #8 P2-01 Instagram adapter
- ✅ #9 P2-02 Instagram onboarding/token lifecycle
- ✅ #10 P2-03 AI draft engine (owner follow-up pending)
- ✅ #11 P2-04 factual/style retrieval (owner follow-up pending)
- ✅ #12 P2-05 deterministic policy engine (owner follow-up pending)
- **NEXT:** #13 P2-06 Delivery Coordinator
- then #14 human handoff/review runtime
- #15 eval/regression corpus
- #16 full Instagram E2E
- independent catch-up #17

### Stage C
#56 reliability / health / kill switches / reconciliation.

### Stage D — Design Partner UI
#27 -> #58 -> #28 -> #29 -> #31 -> #32 -> #30 -> #33 -> #54 -> #55 -> #34 -> #35.

### Stage E
WhatsApp #18 -> #19 -> #20 -> #21 -> #22 -> #23 -> #24.

### Stage F
#57 privacy/security/deletion.

### Stage G
Commercial billing per accepted pricing/specs.

### Stage H
#59 Admin Operations.

### Stage I
#60 Launch Readiness / staged Commercial Beta.

---

## Delivery Coordinator (#13) owner inputs already decided

Implement provider-policy-first timing.

For Instagram AUTOPILOT:
- current provider budget baseline 30s;
- target dispatch about 25s from latest triggering inbound;
- debounce + AI generation + artificial delay share the budget;
- shorten/eliminate artificial delay when required;
- missed deadline -> no normal late AUTOPILOT;
- Human Agent never used as an automation escape hatch.

Also:
- quiet hours defer only if provider eligibility remains valid;
- OFF manual-assist drafts are never auto-scheduled;
- STANDARD_ONLY closed window is SKIP;
- consume channel-discriminated policy input.

---

## Independent review protocol

Claude may continue dependency-safe implementation while Astra review lags, but:
- no feature PR self-merge to `main`;
- no claim of Astra PASS without exact-head independent verdict;
- exact SHAs must be published;
- parent corrections propagate through children with normal merges;
- Commercial Beta requires review catch-up and exact release evidence.

Current earliest unresolved independent dependency: **PR #50**.

---

## Hard invariants — never trade for speed

- Workspace + Business Profile isolation.
- Human activity always wins over AI.
- Stale draft/review/action protection.
- Model output is advisory; application policy authorizes.
- No blind retry after ambiguous external write.
- Provider/webhook/job idempotency.
- Inbound persists even if AI/billing/retrieval is blocked.
- AUTOPILOT is server-side; browser presence is irrelevant.
- Queue is an execution mechanism, not sole durable intent.
- Secrets never enter prompts, ordinary logs, client output or plaintext audit.
- Style never establishes business facts.
- Provider timing/policy beats aesthetic delay.
- Unknown or unverified external outcome is never called success.

---

## Scope guard

Do not block first Commercial Beta on:
- Booking/calendar;
- public API/webhooks;
- broad CRM catalog;
- separate prospecting/acquisition product;
- Telegram/Threads;
- generated media replies;
- universal cross-BP identity graph.

Those are V1.1/later unless a real design partner changes priority.
