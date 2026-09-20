# Current Handoff

**Last updated:** 2026-09-20  
**Repository:** `glebcode1986/omnichannel-ai-setter`  
**Implementation stage:** Stage B complete; Stage C reliability implemented in PR #72; independent review catch-up still blocked at PR #51  
**Immediate correction:** PR #51 delayed-delivery fail-closed bug  
**Do not start Stage D UI until:** #51 is corrected and propagated through the current stack

> **NEW CHAT / NEW AGENT: START HERE.**  
> GitHub is canonical project memory. Chat history is not an execution contract. Fetch live PR HEADs before acting.

## Read order

1. `PROJECT_CONTEXT.md`
2. this file
3. `AGENTS.md`
4. `CLAUDE.md`
5. `docs/tasks/CLAUDE_EXECUTION_QUEUE.md`
6. Master Issue #61
7. exact issue / PR / task contract
8. relevant specs/ADRs

## Executive status

Claude has now implemented:

### Stage B — Instagram + shared AI
- #63 Instagram transport
- #64 Instagram onboarding/token lifecycle
- #65 AI draft engine
- #66 Knowledge/Style retrieval
- #67 deterministic policy
- #68 delivery coordinator
- #69 human handoff / Review state machine
- #70 eval harness / golden cases
- #71 full Instagram vertical slice E2E

### Stage C — reliability
- #72 reliability / health / kill switches / backpressure / reconciliation / incident metrics

PR #72 current snapshot HEAD:
`c2c81a588f31985d0f5cbf58571e050978535e9e`

Claude reports:
- 851 baseline tests;
- 70 E2E tests;
- evals green;
- migration drift 0;
- real PostgreSQL + Redis verification;
- kill switches at global/workspace/BP/channel-account scope;
- durable reconciliation;
- backlog-triggered bounded automation suspension;
- health and incident state;
- recovery re-enters the delivery coordinator instead of replaying sends.

This is implementation evidence, not independent Astra acceptance yet.

## Independent review state

### Accepted
- PR #49 — Astra PASS
- PR #50 — Astra PASS at `3934d99e391337498e7446b8335b90a3f6518b2d`

### Current blocker
PR #51 / P1-04 remains **CHANGES_REQUESTED** at:
`3213497192f96ce15ac92767f855be4b9791d279`

The defect:
`scheduleDelivery` silently clamps a future `scheduledFor` to the queue's 7-day maximum. A declared 30-day send can therefore execute after 7 days while audit state still says 30 days.

Required correction:
- reject out-of-range future schedules before enqueue;
- never clamp/rewrite them earlier;
- write no Redis/BullMQ job on rejection;
- pin exact-max / max+1 / far-future / past-now behavior;
- prevent materially contradictory `scheduledFor` / `selectedDelayMs` audit metadata;
- preserve existing idempotency and channel neutrality.

A focused directive is already posted on PR #51.

### Review queue after #51
After #51 gets a new HEAD and PASS, Astra continues strictly:

#52 -> #63 -> #64 -> #65 -> #66 -> #67 -> #68 -> #69 -> #70 -> #71 -> #72

Do not re-review #50 unless its accepted code changes.

## Current stack snapshot

Fetch live values before modifying.

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
- #72 `c2c81a588f31985d0f5cbf58571e050978535e9e`

## Product-owner decision from Stage C

ADR-017 proposal is **rejected for MVP**.

Do not treat an unmatched outbound echo as proof that an ambiguous automated send succeeded.

Reason:
- human activity always wins;
- false attribution could suppress takeover after a real human reply;
- false takeover / extra Review work is safer than letting AI continue after human intervention.

MVP behavior:
- correlated outbound echo -> may settle the known app operation;
- unmatched outbound echo -> human/native activity and takeover;
- unresolved ambiguous send -> quarantine/reconciliation/manual Review;
- no blind retry.

Canonical ADR:
`docs/adr/ADR-017-ambiguous-send-echo-attribution.md`

## Immediate execution plan

1. Claude returns to PR #51 and fixes the Astra blocker.
2. Publish `CLAUDE_READY_FOR_ASTRA head=<new-sha> task=P1-04`.
3. Propagate with normal merges through every descendant, now including #72.
4. Astra re-reviews #51.
5. If PASS, Astra continues dependency order through #72.
6. Only after that review debt is moving cleanly should new Stage D UI branches begin.

No rebase / force-push of the published stack. No self-merge to main.

## What is implemented but still not production-proven

- Live Meta API traffic has not yet been exercised with real app credentials/test account.
- Stage B/C downstream PRs are not independently accepted yet because review is blocked at #51.
- Reliability notification transport/operator HTTP surface remain later UI/integration work.
- Real production SLOs/load numbers are not yet established.

## Remaining Commercial Beta path

### Stage D — Design Partner UI
#27 -> #58 -> #28 -> #29 -> #31 -> #32 -> #30 -> #33 -> #54 -> #55 -> #34 -> #35

This creates:
- app shell/onboarding;
- EN/RU;
- Inbox;
- Review operations;
- Knowledge/Style UI;
- Test Drive / AI settings;
- Leads;
- customer identity/memory;
- goals/followups/tasks;
- Analytics/Audit;
- responsive/accessibility E2E.

### Stage E — WhatsApp
#18 -> #19 -> #20 -> #21 -> #22 -> #23 -> #24

### Stage F
#57 privacy/security/export/retention/deletion

### Stage G
commercial billing/entitlements/provider integration per #61

### Stage H
#59 Admin Operations

### Stage I
#60 Launch Readiness / release evidence / staged Commercial Beta

## Hard invariants

Never trade these for speed:
- Workspace + Business Profile isolation;
- human activity wins over AI;
- stale-action protection;
- no blind retry after ambiguous external write;
- no delivery earlier than durable declared schedule;
- provider/webhook/job idempotency;
- inbound survives downstream outages;
- AUTOPILOT server-side, browser-independent;
- model output advisory, application policy authoritative;
- queues are execution mechanisms, not sole durable intent;
- secrets stay out of prompts, client output, normal logs and plaintext audit.

## Scope guard

Do not block first Commercial Beta on:
- full Booking/calendar;
- public API/webhooks;
- broad CRM catalog;
- separate prospecting/acquisition product;
- Telegram/Threads;
- generated media replies;
- universal cross-BP identity graph.
