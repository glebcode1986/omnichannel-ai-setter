# Task Contract — P1-04 Claude

**Executor:** Claude Code  
**Issue:** #5 `[P1-04] Implement Business Profile-aware BullMQ job contracts and durable delay primitives`  
**Branch:** `feat/p1-04-bullmq-delay-primitives`  
**Depends on:** corrected/accepted-enough #2 and #3; may remain linearly stacked on #4  
**Merge authority:** human/project owner after review; Claude must not merge its own PR.

## Mandatory reading order

1. `PROJECT_CONTEXT.md`
2. `docs/handoff/CURRENT_HANDOFF.md`
3. `AGENTS.md`
4. `CLAUDE.md`
5. `docs/adr/ADR-003-durable-delayed-delivery.md`
6. `docs/adr/ADR-005-prisma-bullmq-core-stack.md`
7. `docs/adr/ADR-012-delivery-atomic-claim-and-ambiguity.md`
8. `docs/specs/DATA_MODEL.md` v0.4
9. `docs/specs/DELAY_ENGINE.md`
10. `docs/specs/REPOSITORY_LAYOUT.md`
11. `docs/tasks/P1-BP-SYNC_CLAUDE_TASK_CONTRACT.md` when correcting the existing stack
12. GitHub Issue #5

## Objective

Implement durable, channel-neutral BullMQ scheduling primitives for inbound debounce, AI-work triggers, delayed delivery and reconciliation placeholders. Queue execution must preserve Workspace + Business Profile scope. No webhook/request handler may sleep to create human-like delay.

## Owned scope

- `packages/queue`
- minimal worker bootstrap in `apps/worker`
- queue-focused tests/fixtures

## Required job families

- inbound debounce
- AI draft-generation trigger
- delayed delivery
- reconciliation / ambiguous-send follow-up placeholder

Payloads must be strict/versioned and carry stable IDs/correlation data only. Include `workspaceId` and `businessProfileId` on policy-critical work whose authorization/state belongs to a BP. Do not copy full conversation/customer content into queue payloads.

## Required semantics

### Identity / BP scope
- deterministic job IDs include enough Workspace/BP/logical-operation identity to avoid collisions;
- an identical-looking conversation/message/operation ID in a different BP cannot collide;
- queue scope is not authorization authority; application/DB revalidation remains authoritative.

### Debounce
- deterministic reply-cycle/job identity;
- newer inbound makes older work stale/superseded;
- stale jobs are harmless if they wake after best-effort cancellation.

### Delayed delivery
- selected delay + intended schedule are durable/auditable;
- support configured current 30–120s post-draft target;
- no blocking timer/sleep in webhook/request lifecycle;
- final eligibility revalidation belongs to the later delivery coordinator.

### Retry / ambiguity
- only explicitly safe transient work retries;
- `AMBIGUOUS` outbound outcome never enters blind resend;
- reconciliation jobs never themselves perform a resend;
- handler crash during potentially-side-effecting delivery is fail-safe and routed to reconciliation/unknown-outcome handling as required.

### Worker lifecycle
- independent worker start/stop;
- graceful shutdown;
- queue/job names centralized and typed;
- correlation IDs in structured logs without message bodies/secrets.

## Explicitly forbidden

Do not implement provider business rules, real sends, webhook orchestration (#6), AI provider/prompt logic, or Phase-2 final policy/delivery coordinator beyond primitives required here.

## Required tests

Using real Redis where queue identity/scheduling semantics matter, cover:
- malformed/missing BP scope rejection;
- duplicate enqueue;
- same logical IDs in separate BPs produce independent jobs;
- debounce supersession and late stale wake-up;
- durable delayed scheduling across producer/worker restart;
- explicit retryable rejection vs non-retryable rejection;
- ambiguous outcome -> reconciliation/no resend;
- stalled/crashed delivery fail-safe behavior;
- graceful worker close;
- correlation propagation.

## Acceptance checklist

- [ ] typed/versioned job contracts
- [ ] Workspace + BP scope on policy-critical payloads
- [ ] deterministic IDs collision-safe across BPs
- [ ] duplicate enqueue cannot duplicate policy-critical work
- [ ] durable non-blocking delay
- [ ] no Meta/provider strategy in queue package
- [ ] no blind ambiguous retry
- [ ] worker independent of web
- [ ] full required Redis + root verification green

## Existing open stack

PR #51 was implemented before Business Profile v0.4 propagation. Issue #53 governs in-place correction. First merge corrected PR #50 into the branch, then update only queue-owned scope and re-run all verification. Do not force-push/rebase published history solely to simplify the stack.

## PR requirements

Keep/open a focused PR referencing Issue #5. Record Redis setup, job ID/idempotency rules, retry semantics and exact commands. Publish:

`CLAUDE_READY_FOR_ASTRA head=<full_sha> task=P1-04`

Do not merge the PR yourself.