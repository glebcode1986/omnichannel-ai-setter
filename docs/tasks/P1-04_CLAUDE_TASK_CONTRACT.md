# Task Contract — P1-04 Claude

**Executor:** Claude Code  
**Issue:** #5 `[P1-04] Implement BullMQ job contracts and durable delay primitives`  
**Branch:** `feat/p1-04-bullmq-delay-primitives`  
**Depends on:** accepted #2 and #3; may proceed alongside #4 after shared IDs/types stabilize  
**Merge authority:** Human/project owner after review; Claude must not merge its own PR.

## Mandatory reading order

1. `PROJECT_CONTEXT.md`
2. `docs/handoff/CURRENT_HANDOFF.md`
3. `AGENTS.md`
4. `CLAUDE.md`
5. `docs/adr/ADR-003-durable-delayed-delivery.md`
6. `docs/adr/ADR-005-prisma-bullmq-core-stack.md`
7. `docs/adr/ADR-012-delivery-atomic-claim-and-ambiguity.md`
8. `docs/specs/DELAY_ENGINE.md`
9. `docs/specs/REPOSITORY_LAYOUT.md`
10. GitHub Issue #5

## Objective

Implement durable, channel-neutral BullMQ scheduling primitives for inbound debounce, AI-work triggers, delayed delivery and reconciliation placeholders. No webhook/request handler may sleep to create a human-like delay.

## Owned scope

- `packages/queue`
- minimal worker bootstrap in `apps/worker`
- queue-focused tests/fixtures

## Required job families

At minimum:

- inbound debounce
- AI draft-generation trigger
- delayed delivery
- reconciliation / ambiguous-send follow-up placeholder

Job payloads must be runtime-validated, versionable and carry stable IDs/correlation data rather than copied full conversation content wherever possible.

## Required semantics

### Debounce

- deterministic job/reply-cycle identity;
- a newer inbound burst makes older debounce work stale/superseded;
- stale jobs are safe if they still wake up after cancellation attempts.

### Delayed delivery

- selected delay and intended schedule are durable/auditable;
- initial product range is configurable and supports the current 30–120 second target;
- no `sleep()`/blocking timer in webhook/request lifecycle;
- execution re-check belongs to delivery coordinator later, but queue primitives must support stale/cancelled ownership cleanly.

### Retry/ambiguity

- safe transient work may retry according to explicit policy;
- an `AMBIGUOUS` outbound-send outcome must never enter a blind resend loop;
- reconciliation jobs are distinct from resend jobs.

### Worker lifecycle

- independent worker start/stop;
- graceful shutdown;
- observable enqueue/processing with correlation IDs;
- queue names/job names are centralized and typed.

## Explicitly forbidden

Do not implement:

- Meta/Instagram/WhatsApp business rules;
- actual outbound provider sends;
- webhook route orchestration (#6);
- AI prompt/provider logic;
- final Phase 2 policy/delivery coordinator logic beyond the queue primitives needed by this issue.

## Required tests

Cover at least:

- malformed job payload rejection;
- deterministic duplicate enqueue behavior;
- debounce supersession;
- durable delayed scheduling;
- worker restart/retry-safe job identity;
- explicit no-auto-retry path for ambiguous send state;
- graceful worker lifecycle where testable.

Use test Redis or a documented deterministic substitute appropriate for the repo setup; do not fake away semantics that are specific to BullMQ job identity/scheduling.

## Acceptance checklist

- [ ] typed/versioned queue contracts exist
- [ ] payloads have runtime validation
- [ ] duplicate enqueue cannot create duplicate policy-critical work
- [ ] debounce supersession is tested
- [ ] delayed scheduling is durable and non-blocking
- [ ] no Meta-specific logic exists in queue package
- [ ] ambiguous outcome has no blind resend path
- [ ] worker can run independently of web app
- [ ] correlation IDs are propagated through enqueue/process logs
- [ ] root lint/typecheck/test pass

## PR requirements

Open a focused PR into `main` referencing Issue #5. Include exact Redis/test setup, commands run, job naming/idempotency rules and retry policy summary.

Do not merge the PR.
