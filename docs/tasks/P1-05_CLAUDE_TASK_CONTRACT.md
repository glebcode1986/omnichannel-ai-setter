# Task Contract — P1-05 Claude

**Executor:** Claude Code  
**Issue:** #6 `[P1-05] Implement channel-neutral webhook ingestion pipeline`  
**Branch:** `feat/p1-05-webhook-ingestion`  
**Depends on:** accepted #3, #4 and #5  
**Merge authority:** Human/project owner after review; Claude must not merge its own PR.

## Mandatory reading order

1. `PROJECT_CONTEXT.md`
2. `docs/handoff/CURRENT_HANDOFF.md`
3. `AGENTS.md`
4. `CLAUDE.md`
5. `docs/adr/ADR-001-channel-agnostic-core.md`
6. `docs/adr/ADR-003-durable-delayed-delivery.md`
7. `docs/adr/ADR-004-human-override-wins.md`
8. `docs/specs/CHANNEL_CONTRACTS.md`
9. `docs/specs/ARCHITECTURE.md`
10. `docs/specs/DATA_MODEL.md`
11. GitHub Issue #6

## Objective

Implement the channel-neutral webhook application flow using a deterministic fake/test adapter before any real Instagram or WhatsApp transport exists.

## Owned scope

- `packages/application`
- minimal route/composition wiring in `apps/web`
- fake/test channel adapter and integration fixtures needed by this issue

## Required processing flow

1. resolve channel account/workspace from route/configuration context;
2. capture the raw webhook input needed for verification;
3. call `ChannelAdapter.verifyWebhook()`;
4. reject failed verification before normalization/persistence;
5. call `ChannelAdapter.normalizeWebhook()`;
6. idempotently persist source events/messages/status changes;
7. update contact identity/conversation state;
8. classify outbound echoes sufficiently to preserve known app-originated sends vs human/manual signals according to existing contracts;
9. enqueue eligible inbound debounce work;
10. return HTTP success quickly without AI generation or artificial delay.

## Consistency/idempotency requirements

- duplicate source events are safe;
- duplicate webhook delivery cannot enqueue duplicate reply cycles;
- persistence + enqueue intent must have an explicit consistency strategy (transactional record/outbox-equivalent/recoverable enqueue design as appropriate);
- unknown normalized event variants are auditable and fail safely;
- correlation ID spans route, verification/normalization, persistence and enqueue;
- no provider-specific payload fields escape adapter normalization into application use cases.

## Fake adapter

Create a deterministic fake/test `ChannelAdapter` supporting fixtures for:

- inbound text
- multi-event webhook
- duplicate event
- outbound echo
- delivery/read status
- verification success/failure
- rejected/unknown event where useful

The fake is a test mechanism, not a production channel implementation.

## Explicitly forbidden

Do not implement:

- real Meta webhook parsing/signature logic;
- Instagram/WhatsApp OAuth or sends;
- LLM/retrieval/prompt generation;
- human-like post-draft delay logic beyond enqueueing the already-defined debounce primitive;
- Phase 2 policy/delivery coordinator.

## Required tests

Integration coverage must include:

- valid inbound message path;
- duplicate webhook/source-event idempotency;
- invalid verification rejection before persistence;
- multi-event webhook;
- delivery/read status update;
- outbound echo event path;
- enqueue failure/recovery behavior according to chosen consistency strategy;
- proof that route returns without waiting for AI/delay processing.

## Acceptance checklist

- [ ] route is thin transport/composition only
- [ ] verification precedes normalization/business processing
- [ ] duplicate source events are idempotent
- [ ] duplicate webhook cannot create duplicate reply cycles
- [ ] persistence/enqueue consistency strategy is documented/tested
- [ ] correlation ID spans ingress -> DB -> queue
- [ ] fake adapter provides deterministic fixture coverage
- [ ] no Meta fields leak into application core
- [ ] no LLM call exists in webhook lifecycle
- [ ] no sleep/artificial wait exists in webhook lifecycle
- [ ] root lint/typecheck/test pass

## PR requirements

Open a focused PR into `main` referencing Issue #6. Include the ingestion sequence, consistency/idempotency strategy, exact test scenarios and commands run.

Do not merge the PR. Phase 1 is not complete until Issue #7 independent review has run against the merged/reviewable Phase 1 surface.
