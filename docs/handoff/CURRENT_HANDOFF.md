# Current Handoff

**Last updated:** 2026-09-26  
**Repository:** `glebcode1986/omnichannel-ai-setter`  
**Implementation:** Stage B complete in code; Stage C reliability complete in code  
**Independent review:** accepted through PR #68 / P2-06; current blocker is PR #69 / P2-07  
**Active now:** Claude has a fresh P2-07 human-approved-delivery directive; Astra watcher is armed for the next corrected #69 HEAD  
**Stage D:** paused until the Stage B/C review train clears

> **NEW CHAT / NEW AGENT: START HERE.**
> GitHub is canonical project memory. Fetch live PR HEADs and latest review markers before acting.

## Read order

1. `PROJECT_CONTEXT.md`
2. this file
3. `AGENTS.md`
4. `CLAUDE.md`
5. `docs/tasks/CLAUDE_EXECUTION_QUEUE.md`
6. Master Issue #61
7. current PR / issue / task contract
8. relevant specs / ADRs

## Independent review progress

Current accepted chain includes:

- PR #51 / P1-04 — accepted failure-safety, schedule-range and later shutdown hardening
- PR #52 / P1-05 — accepted secret-safe verification logging
- PR #63 / P2-01 — accepted Instagram adapter + scope/Human-Agent binding
- PR #64 / P2-02 — accepted credential lifecycle/reconnect safety
- PR #65 / P2-03 — accepted AI draft repair-stage UNAVAILABLE/no-write behavior
- PR #66 / P2-04 — accepted retrieval/style-language production wiring; current propagated HEAD `9976cfc86ea17410e8058d1b39b7a81b5feedea3`
- PR #67 / P2-05 — accepted deterministic policy / stale Human Agent eligibility guard; current HEAD `d38dbd4948ad75e01571d4f274e5308b4d46f19d`
- PR #68 / P2-06 — accepted delivery coordinator serialization/claim correction at `fb35665209b90c82bc10f3068450111e75f83299`

### What #68 fixed before PASS

Astra found several progressively deeper send-authority races:

1. revalidation state could change after read but before delivery-row claim;
2. a larger conditional WHERE still did not serialize concurrent writers under READ COMMITTED;
3. an absent automation-policy row could be inserted as a phantom while a claim was in progress.

Final accepted design:
- claim shares real row locks with inbound/takeover/draft/account/existing-policy writers;
- Business Profile is locked FOR UPDATE to serialize creation of previously absent policy rows through FK key-share conflict;
- policy/channel facts come from the coordinator's single guarded read;
- atomic claim reasserts the exact state used for revalidation.

This is independently accepted at:
`ASTRA_REVIEW: PASS head=fb35665209b90c82bc10f3068450111e75f83299`

## Current blocker — PR #69 / P2-07

Current live HEAD:
`d8b56c91d710a435e7b2614f69fcd39297357f68`

Astra verdict:
`ASTRA_REVIEW: CHANGES_REQUESTED head=d8b56c91d710a435e7b2614f69fcd39297357f68`

### Blocking defect

Human Review approval is not durable delivery authority.

Current flow:
- `resolveReview` receives a human actor + `reviewMode`;
- it schedules an ordinary delivery without persisting that authority/intent;
- it separately sets `HUMAN_ACTIVE`;
- worker later constructs every queued send as `authority: AUTOMATED`.

Consequences:
- a human-approved DRAFT-mode reply can be blocked by its own takeover;
- HUMAN_AGENT review cannot reach the adapter as a deliberate human action;
- schedule vs takeover is race-dependent;
- a reviewed send can be misclassified as automation.

### Required correction now assigned to Claude

The P2-07 fix directive on PR #69 requires:

- durable delivery authority: `AUTOMATED | HUMAN_APPROVED`;
- human approver user id + approval timestamp;
- durable normal-vs-HUMAN_AGENT reviewed transport intent;
- only authenticated USER may create HUMAN_APPROVED authority;
- review scheduling + HUMAN_ACTIVE takeover committed atomically;
- worker consumes persisted authority instead of inventing AUTOMATED;
- authority/intent bound to the final claim/revalidation guard;
- HUMAN_AGENT still requires fresh eligibility immediately before dispatch;
- new inbound/newer human activity/policy/account/window changes remain fail-closed;
- sent-message/audit provenance reflects reviewed-human vs automated path;
- real DB + queue + coordinator E2E regressions, not only schedule stubs.

Claude must publish:

`CLAUDE_READY_FOR_ASTRA head=<new-full-sha> task=P2-07`

Astra watcher is explicitly armed to ignore the rejected old SHA and re-review only the first corrected exact #69 HEAD.

## Current downstream heads

These descendants contain the rejected/current #69 parent and are not independently cleared yet:

- #70 / P2-08: `41a926047e10985e7e8a4ebbfd73f8094b8b253a`
- #71 / P2-09: `b0a606917a28b2702b88c061c22bfec96f6effdd`
- #72 / P3-03: `1f90fe1a532d88b11d72c592ff2288a81af08ba5`

After #69 PASS, normal-merge the accepted correction through #70 -> #71 -> #72, verify each exact HEAD, then continue independent review in order.

## Implementation status

### Stage B implemented
Instagram transport/onboarding, AI draft engine, Knowledge/Style retrieval, deterministic policy, delivery coordinator, Human Handoff/Review, evaluation harness, Instagram vertical slice E2E.

### Stage C implemented
Reliability/health, scoped kill switches, backpressure, reconciliation, incident state and safe recovery.

The latest #72 propagated implementation passed its local/full verification before the current #69 review blocker, but Stage C is not independently review-cleared until its parent chain is accepted.

## Remaining Commercial Beta path

After review-safe Stage B/C:

- Stage D — Design Partner UI
- Stage E — WhatsApp
- Stage F — privacy/security/export/retention/deletion
- Stage G — billing/entitlements
- Stage H — Admin Operations
- Stage I — Launch Readiness / staged Commercial Beta

## Hard invariants

- Workspace + Business Profile isolation
- human activity always wins
- explicit human action is required for HUMAN_APPROVED/HUMAN_AGENT
- no stale send
- no blind retry after ambiguous external write
- no early delivery
- unknown invariants fail closed
- transient provider failure remains retryable and does not become permanent customer state
- provider/webhook/job idempotency
- queues are execution mechanisms, not sole durable intent
- model output is advisory; application policy authorizes
- secrets never enter prompts, client output, normal logs or plaintext audit
