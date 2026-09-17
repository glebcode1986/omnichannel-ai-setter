# Task Contract — P1-05 Claude

**Executor:** Claude Code  
**Issue:** #6 `[P1-05] Implement Business Profile-aware channel-neutral webhook ingestion`  
**Branch:** `feat/p1-05-webhook-ingestion`  
**Depends on:** corrected/accepted-enough #3, #4 and #5  
**Merge authority:** human/project owner after review; Claude must not merge its own PR.

## Mandatory reading order

1. `PROJECT_CONTEXT.md`
2. `docs/handoff/CURRENT_HANDOFF.md`
3. `AGENTS.md`
4. `CLAUDE.md`
5. `docs/adr/ADR-001-channel-agnostic-core.md`
6. `docs/adr/ADR-003-durable-delayed-delivery.md`
7. `docs/adr/ADR-004-human-override-wins.md`
8. `docs/specs/DATA_MODEL.md` v0.4
9. `docs/specs/CHANNEL_CONTRACTS.md`
10. `docs/specs/ARCHITECTURE.md`
11. `docs/tasks/P1-BP-SYNC_CLAUDE_TASK_CONTRACT.md` when correcting the existing stack
12. GitHub Issue #6

## Objective

Implement channel-neutral webhook application flow with a deterministic fake/test adapter. Resolve every provider event into authoritative Workspace + Business Profile + ChannelAccount scope before customer data changes. No real Meta adapter yet.

## Owned scope

- `packages/application`
- minimal route/composition wiring in `apps/web`
- fake/test channel adapter and integration fixtures
- minimal DB/outbox hooks required by the ingestion contract when they cannot live elsewhere, without turning this into a general DB feature task

## Required processing flow

1. resolve ChannelAccount plus its Workspace and Business Profile from trusted route/config/provider identity;
2. capture raw webhook input required for verification;
3. call `verifyWebhook()` first;
4. reject verification failure before normalization/persistence;
5. normalize to shared `NormalizedChannelEvent[]`;
6. validate each event against resolved Workspace/BP/account/channel scope;
7. idempotently persist source event + message/status changes;
8. create/update Contact and ChannelIdentity only inside the resolved BP;
9. create/update Conversation with Workspace + BP consistency and monotonic state/version semantics;
10. classify outbound echoes using stable operation/provider correlation, never message-text matching;
11. transactionally persist enqueue intent/outbox with BP scope;
12. enqueue eligible inbound debounce work carrying BP scope;
13. return provider ACK quickly without AI generation or human-like delay.

## Consistency / idempotency requirements

- duplicate source events are safe;
- duplicate webhook cannot create duplicate reply cycles;
- persistence + enqueue intent has transactional/outbox-equivalent recoverability;
- unknown/invalid/foreign BP events are auditable and fail safely;
- correlation ID spans route -> normalized event -> DB/outbox -> queue;
- no provider-specific fields escape adapter normalization into application logic;
- outbox recovery preserves the original Workspace/BP identity and does not restart obsolete business intent blindly.

## Fake adapter

Provide deterministic fixtures for inbound text, multi-event webhook, duplicate event, outbound echo, delivery/read status, verification success/failure and unknown/unsupported event handling. The fake is not a production channel.

## Explicitly forbidden

Do not implement real Meta signatures/payload parsing, OAuth, real sends, LLM/retrieval, post-draft delivery policy, or Phase-2 AI orchestration.

## Required tests

Integration coverage must include:
- valid inbound in BP1;
- one Workspace with BP1 + BP2 producing independent contacts/conversations;
- same external/provider user ID in separate BPs where account semantics permit it;
- forged/foreign Workspace/BP/account event rejected with no customer/outbox side effect;
- duplicate and concurrent duplicate delivery;
- invalid verification before persistence;
- multi-event webhook;
- delivery/read status progression and reordering;
- own API echo vs unmatched human/manual echo;
- enqueue failure + outbox recovery preserving BP scope;
- proof route returns without LLM or artificial delay.

## Acceptance checklist

- [ ] route thin transport/composition only
- [ ] ChannelAccount -> Workspace + BP is authoritative
- [ ] verification before normalization/business processing
- [ ] duplicate source events/reply cycles idempotent
- [ ] cross-BP data creation cannot occur
- [ ] Contact/ChannelIdentity/Conversation are created inside resolved BP
- [ ] transaction/outbox consistency documented and tested
- [ ] correlation spans ingress -> DB -> queue
- [ ] no Meta fields leak into application core
- [ ] no LLM/sleep in webhook lifecycle
- [ ] DB + Redis + root verification pass

## Existing open stack

PR #52 was implemented before Business Profile v0.4 propagation. Issue #53 governs in-place correction. First merge corrected PR #51 into this branch, then update ingestion-owned scope and re-run all required DB/Redis/root tests. No child merge before parents; do not force-push/rebase published history solely to simplify the stack.

## PR requirements

Keep/open a focused PR referencing Issue #6. Include exact ingestion sequence, Workspace/BP resolution, outbox/idempotency strategy, tests and commands. Publish:

`CLAUDE_READY_FOR_ASTRA head=<full_sha> task=P1-05`

Do not merge the PR yourself. Phase 2 may start only after Issue #53 sync is green.