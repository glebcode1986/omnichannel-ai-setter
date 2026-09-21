# Current Handoff

**Last updated:** 2026-09-21  
**Repository:** `glebcode1986/omnichannel-ai-setter`  
**Implementation:** Stage B complete; Stage C reliability implemented; review catch-up currently blocked again at PR #51  
**Immediate action:** Claude is explicitly re-started on PR #51 R3; Astra watcher is armed for the next new #51 HEAD  
**Stage D:** still paused

> **NEW CHAT / NEW AGENT: START HERE.**  
> GitHub is canonical project memory. Fetch live PR HEADs before acting.

## Read order

1. `PROJECT_CONTEXT.md`
2. this file
3. `AGENTS.md`
4. `CLAUDE.md`
5. `docs/tasks/CLAUDE_EXECUTION_QUEUE.md`
6. Master Issue #61
7. current PR / issue / task contract
8. relevant specs / ADRs

## What has happened since the previous handoff

### PR #51 scheduling bug was fixed and passed
The earlier fail-unsafe 30-day -> 7-day clamp was corrected and independently accepted at:

`1fb13b1aef0dd8dac5d905a4af7169f9735a7ef6`

That fix rejects unsupported future schedules before enqueue and pins exact-max/max+1/far-future/past-now/metadata consistency with real Redis tests.

### PR #52 logging-security bug was fixed and passed
Astra found that adapter-controlled `VerificationResult.REJECTED.reason` could leak bearer/signature/body/query data into structured logs.

Claude fixed it by discarding the free text and logging only application-owned closed codes. Astra PASS:

`cbf6e119628bd924c8c59ff39949b3f839808349`

### Claude corrected false mutation-test confidence
Claude discovered that the old scratch mutation harness was invalid:
- package `node_modules` symlinks made the architecture baseline red;
- monorepo links pointed tests back to unmutated source;
- therefore several earlier “all mutants killed” numbers were not real measurements.

He repaired the harness, required a green baseline, re-ran the affected P2 tasks, and closed real test gaps. Examples found/fixed include:
- retrieval similarity threshold interpreted incorrectly;
- archived Style examples still eligible;
- unsafe full-text query token handling;
- candidate-cap/fusion edge cases;
- policy capability mismatch;
- quiet-hours midnight handling;
- delivery coordinator losing review-required state;
- deferral to an already-past instant.

This produced many propagation comments and changing HEADs. This is review/test hardening, not a new product-scope expansion.

## Current blocker — PR #51 again

Current PR #51 HEAD:
`b5063ab67e556132e9afbe5f006edebeb7714349`

A new worker-reliability defect was found while exact-head CI/review continued.

### The issue

The worker originally crashed during a Redis reconnect because Node surfaced an unhandled promise rejection as fatal.

Claude first made all unhandled rejections survivable. Astra correctly rejected that as too broad.

Claude narrowed it to:
- connection-like error code; and
- one of this worker's Redis clients currently not ready.

Astra rejected the current rule too, because this is still **temporal correlation, not source attribution**.

While Redis is down, an unrelated PostgreSQL/HTTP/pipe/logging rejection with `ECONNRESET`, `ETIMEDOUT`, `EPIPE`, etc. is still incorrectly treated as safe to continue.

### Required correction

- global `uncaughtException` remains fatal;
- global `unhandledRejection` also remains fatal after secret-safe logging;
- remove generic “survivable if Redis is down” logic from the process-wide handler;
- contain the known BullMQ/ioredis reconnect rejection only at the actual promise/emitter boundary that owns it;
- if true source ownership cannot be established, prefer process failure/restart over guessing;
- add an adversarial child-process regression where Redis is down and an unrelated rejection carries the **same network code**; that unrelated failure must still terminate the worker.

A focused R3 directive is posted on PR #51.

## Review implications

Exact-head review discipline matters.

Earlier PASSes remain valid for the exact SHAs they reviewed, but current descendant HEADs moved because parent fixes were propagated.

Current live stack snapshot:

- #51 `b5063ab67e556132e9afbe5f006edebeb7714349` — **CHANGES_REQUESTED**
- #52 `b02a022a971d86347cb06d4501ad319016d41cf4`
- #63 `ee22dba13156a01f2fbbe1dbfbe5c83f59b7eef5`
- #64 `e0a64ad75709b01415364bffafbd9048be0cfbd6`
- #65 `76e64d60a1ec327ec960ad4ab22056d43c398fab`
- #66 `98a6c5e545283a66a37abe9e22766f9bb3d87c4e`
- #67 `aeebfa306243fc67da7b1d8ac03b33f90031a930`
- #68 `7c637ede17b8e26349059a695a0501f2d281801d`
- #69 `9ea56c6df978506c4ac6987ec50d03f4a43a24d1`
- #70 `aac5a96061faa88f980d06292d2ba8168f30242b`
- #71 `5a460881d2557d89cee7933a160908466a7fd7be`
- #72 `60dd541055498cf8902ca4d49e596fe7e60211e3`

Do not review downstream exact HEADs as accepted while #51 remains red.

## Implementation status

### Stage B implemented
#63 -> #71:
Instagram transport/onboarding, AI draft, Knowledge/Style retrieval, deterministic policy, delivery coordinator, human handoff/Review, eval harness, Instagram E2E slice.

### Stage C implemented
#72:
health, scoped kill switches, backpressure, durable reconciliation, incidents/metrics, safe recovery.

Latest Claude verification reported at #72:
`pnpm verify` 894 tests passed on the current propagated head.

This is implementation evidence, not independent acceptance of the whole current stack.

## Product-owner decision preserved

ADR-017 remains rejected for MVP:
- unmatched outbound echo remains native/manual human activity;
- ambiguous automated send stays quarantined unless authoritative correlation exists;
- human takeover safety wins;
- no blind retry.

## Immediate execution plan

1. Claude fixes current PR #51 source-attribution defect.
2. Publish a new exact:
   `CLAUDE_READY_FOR_ASTRA head=<sha> task=P1-04`
3. Astra re-reviews #51 first.
4. Only after PASS, propagate that accepted correction through #52 -> #72.
5. Astra continues strict dependency order.
6. Stage D stays paused until this lower-layer reliability issue is cleanly resolved.

## Remaining Commercial Beta path

After review-safe Stage B/C:

### Stage D — Design Partner UI
App shell/onboarding, EN/RU, Inbox, Review, Knowledge, Style, AI settings/Test Drive, Leads, memory/identity, follow-ups/tasks, Analytics/Audit, responsive/accessibility.

### Stage E — WhatsApp
#18 -> #24.

### Stage F
Privacy/security/export/retention/deletion.

### Stage G
Commercial billing/entitlements/provider integration.

### Stage H
Admin Operations.

### Stage I
Launch Readiness / staged Commercial Beta.

## Hard invariants

- Workspace + Business Profile isolation.
- Human activity always wins over AI.
- No stale send.
- No blind retry after ambiguous external write.
- No delivery earlier than durable declared schedule.
- Unknown process invariants fail closed.
- Provider/webhook/job idempotency.
- Inbound survives downstream outages.
- AUTOPILOT is server-side.
- Model output is advisory; application policy authorizes.
- Queues are execution mechanisms, not sole durable intent.
- Secrets never enter prompts, client output, normal logs or plaintext audit.


## Watcher / execution restart — 2026-09-21

Two explicit GitHub commands were posted on PR #51:

- **Claude:** resume immediately from the unresolved R3 source-attribution defect on current rejected HEAD `b5063ab67e556132e9afbe5f006edebeb7714349`; publish a new `CLAUDE_READY_FOR_ASTRA ... task=P1-04` exact HEAD.
- **Astra watcher:** do not waste a re-review on the same rejected HEAD; automatically re-fetch/re-review the first newer #51 HEAD when Claude publishes the marker, then continue strict dependency order.

P2-01 PR #63 also has a completed R2 correction waiting in the queue:
`628c6026d151b613ba02be17beb7a4175cbfa579`

That fix binds Human Agent eligibility to the actual outbound recipient/conversation and enforces adapter Workspace/BP/channel-account scope before credentials/HTTP. It has been propagated through #72, but Astra should review it only after the dependency queue passes #51 and #52.
