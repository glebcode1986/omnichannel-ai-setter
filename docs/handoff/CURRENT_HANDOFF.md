# Current Handoff

**Last updated:** 2026-09-19  
**Repository:** `glebcode1986/omnichannel-ai-setter`  
**Implementation stage:** Stage B code complete through Instagram end-to-end slice; independent review catch-up is blocked at PR #51  
**Next Claude correction:** PR #51 BullMQ delayed-schedule fail-closed fix  
**Next new feature after review-safe propagation:** Stage C / Issue #56 reliability, health, kill switches, reconciliation

> **NEW CHAT / NEW AGENT: START HERE.**  
> GitHub is canonical project memory. Chat history is not an execution contract. Fetch live PR HEADs before acting.

## Read order

1. `PROJECT_CONTEXT.md`
2. **this file**
3. `AGENTS.md`
4. `CLAUDE.md`
5. `docs/tasks/CLAUDE_EXECUTION_QUEUE.md`
6. Master Issue **#61**
7. exact current PR/issue/task contract
8. relevant specs/ADRs

## Executive status

Claude has implemented the complete Stage B stack:

- P2-01 Instagram transport adapter — PR #63
- P2-02 Instagram Login/token lifecycle — PR #64
- P2-03 provider-neutral AI draft engine — PR #65
- P2-04 factual/style retrieval — PR #66
- P2-05 deterministic policy engine — PR #67
- P2-06 delivery coordinator — PR #68
- P2-07 human handoff/review state machine — PR #69
- P2-08 evaluation harness/golden suite — PR #70
- P2-09 Instagram vertical slice E2E — PR #71

Claude reports the vertical slice can now ingest and reply in DRAFT and has a server-side AUTOPILOT path that is delayed, stale-safe, takeover-safe and ambiguity-safe. Live Meta traffic is still unverified because real Meta app credentials/test traffic have not yet been exercised.

Independent Astra review is intentionally moving in dependency order and has **not** accepted the downstream Stage B stack yet.

## Independent review state

### PR #49 — PASS
Accepted exact HEAD:
`34a71d0d36b04f2c8933aa29479e26cbc87e7800`

### PR #50 — PASS
Accepted exact HEAD:
`3934d99e391337498e7446b8335b90a3f6518b2d`

Astra independently verified via GitHub Actions:
- migration/schema drift;
- 60 PostgreSQL DB tests;
- deterministic two-real-message concurrency regression;
- Workspace/BP isolation;
- composite FK/constraints;
- root verify;
- worker command on that stack.

The earlier nonexistent CI-script issue is resolved on #50.

### PR #51 — CURRENT BLOCKER / CHANGES_REQUESTED
Reviewed exact HEAD:
`3213497192f96ce15ac92767f855be4b9791d279`

Astra found a real queue scheduling defect:

`scheduleDelivery` derives a future delay from `scheduledFor` and silently clamps it to `MAX_SCHEDULE_DELAY_MS` (7 days).

Example: a payload declaring 30 days can actually execute after 7 days while its payload still claims the original 30-day `scheduledFor`. This can send a customer message materially early.

Required correction:
- never clamp an out-of-range future delivery earlier;
- if derived delay > supported max, reject before enqueue;
- no BullMQ job must be written;
- pin exact-max accepted / max+1 rejected / far-future rejected / past-now semantics;
- prevent materially contradictory `selectedDelayMs` / `scheduledFor` audit metadata;
- preserve channel neutrality and existing idempotency.

A focused implementation directive is already posted on PR #51.

After Claude fixes #51:
1. publish `CLAUDE_READY_FOR_ASTRA head=<new-sha> task=P1-04`;
2. propagate with normal merges through all child branches;
3. Astra re-reviews #51 first;
4. only after PASS does Astra continue #52 -> #63 -> #64 -> #65 -> #66 -> #67 -> #68 -> #69 -> #70 -> #71.

Do not re-run Astra on the old #51 HEAD and do not re-review #50; #50 is already PASS.

## Current live PR snapshot

Fetch live values before modifying. Snapshot at handoff update:

- #50 `3934d99e391337498e7446b8335b90a3f6518b2d` — PASS
- #51 `3213497192f96ce15ac92767f855be4b9791d279` — CHANGES_REQUESTED
- #52 `cd89333ca7c11d77cc7b606ee40f95ee1c909a2b`
- #63 `d117291dded9fff6c1f9ce421a5af4a21308dfba`
- #64 `0fc59ff60e53f9c130de3d4d74215f6ec6b350f8`
- #65 `99dc18aff9210318639da19d54bad759937b7432`
- #66 `23dc6d0df7c39144962575face2f6d02c053efbd`
- #67 `2ad689347a276fe50ef8a422f2a839002a268d0f`
- #68 `73b7ce074d0f500e0a49a1cd6e70bf1e768fae05`
- #69 `21e31fa3405d408e75b9f9bf777c58aee5ae7e9f`
- #70 `cdbf9bd5924be99d2d24ae02dd7cfe2edebad310`
- #71 `5126e4e6e81b41ebb47e680f8843b660ae4b8575`

## CI status

GitHub Actions workflow is active at:

`.github/workflows/verify.yml`

It has been propagated into the active implementation stack, so exact PR heads can now receive neutral CI evidence.

Current workflow covers:
- root `pnpm verify`;
- pgvector/PostgreSQL 17;
- schema/migration drift;
- DB suites;
- Redis suites where present;
- worker/E2E suites where present.

Do not count an empty/no-test Redis command as Redis verification. Verify the exact suite actually executed on each PR.

## Stage B implementation notes

### PR #65 owner follow-ups applied
- OFF permits explicit authorized human-requested AI draft only;
- human-requested trigger is represented as a discriminated human source;
- such a draft is always review/manual-assist and never auto-sent;
- business persona moved to customer-owned StyleProfile;
- resolution: Workspace base -> BP override -> future conversation-level downward override -> generic fallback.

### PR #66 owner follow-ups applied
- minimal internal/dev/test Knowledge + Style seeding path added;
- normal Workspace/BP authorization/provenance preserved;
- no semantic guessing of knowledge overrides;
- StyleExample supports optional BCP-47 language;
- missing embeddings degrades lexical-only and is visible diagnostically.

### PR #67 owner follow-ups applied
- Instagram STANDARD_ONLY closed window -> SKIP routine automation;
- quiet hours defer only if the future send still fits provider eligibility;
- otherwise safe hold/terminal outcome, never late blind send;
- after-window policy is channel-discriminated;
- OFF manual-assist never enters automatic scheduling.

### PR #68 delivery coordinator implemented
Owner timing rules:
- provider timing beats aesthetic/human-like delay;
- current Instagram automated baseline: 30s;
- operational target about 25s;
- debounce + generation + artificial delay share total budget;
- artificial delay may become zero;
- missed deadline -> no ordinary late AUTOPILOT;
- Human Agent remains explicit-human only;
- ambiguous sends quarantine/reconcile, never blind retry.

### PR #69
Human handoff/review state machine implemented with real DB race test for review claiming.

### PR #70
AI evaluation harness + golden suite implemented. No live provider dependency required.

### PR #71
Instagram vertical slice E2E implemented. Honest known gaps:
- real Meta API traffic still not exercised;
- reconciliation consumer is Stage C (#56);
- some web adapter registration is visible follow-up rather than hidden.

## Next execution plan

### Immediate
1. Claude fixes PR #51 Astra finding.
2. Propagate new #51 parent through all descendants with normal merges.
3. Astra re-reviews new #51 HEAD.
4. Astra continues in dependency order after PASS.

### New feature work after Stage B
Issue #56 — reliability / health / kill switches / reconciliation / safe recovery.

Then Design Partner UI:
#27 -> #58 -> #28 -> #29 -> #31 -> #32 -> #30 -> #33 -> #54 -> #55 -> #34 -> #35.

Then WhatsApp:
#18 -> #19 -> #20 -> #21 -> #22 -> #23 -> #24.

Then:
#57 privacy/security/deletion -> commercial billing -> #59 Admin Operations -> #60 Launch Readiness.

## Accepted product decisions to preserve

- Human Agent is Instagram-specific and explicit-human only.
- Provider timing policy overrides generic delay preferences.
- OFF disables background automation but permits explicit human AI-assist draft.
- StyleProfile is customer-owned; style never establishes factual truth.
- Knowledge overrides require explicit relationship; no semantic shadow guessing.
- Embeddings may degrade lexical-only.
- STANDARD_ONLY closed window does not flood Review with unsendable drafts.
- Quiet hours defer only when provider eligibility remains valid.
- AUTOPILOT is fully server-side and must work with browser closed.
- Human activity wins over AI.
- Unknown external-write outcome -> reconciliation, never blind retry.

## Hard invariants

Never cut these for speed:
- Workspace + Business Profile isolation;
- exact tenant/BP authorization;
- stale draft/review/action protection;
- provider/webhook/job idempotency;
- no blind resend after ambiguity;
- no early delivery relative to declared durable schedule;
- queues are not sole durable intent;
- model output is advisory;
- secrets never enter prompts/normal logs/client output/plaintext audit;
- inbound persists even when downstream automation is blocked.

## Scope guard

Do not block first Commercial Beta on:
- Booking/calendar;
- public API/webhooks;
- broad CRM connector catalog;
- separate prospecting product;
- Telegram/Threads;
- generated media replies;
- universal cross-BP identity graph.
