# Current Handoff

**Date:** 2026-09-17  
**Phase:** Active implementation — Phase 1 stacked implementation exists; Business Profile v0.4 sync is the current blocking correction before Phase 2  
**Repository:** `glebcode1986/omnichannel-ai-setter`

## Source of truth

GitHub issues/specs/task contracts are authoritative. Chat history is not an execution contract.

For Claude execution, read in this order:
1. `PROJECT_CONTEXT.md`
2. this handoff
3. `AGENTS.md`
4. `CLAUDE.md`
5. `docs/tasks/CLAUDE_EXECUTION_QUEUE.md`
6. exact issue + task contract
7. relevant ADR/specs

Master execution index: **Issue #61 — Claude MVP build train**.

## Current live implementation stack

The Phase 1 implementation has progressed beyond the old scaffold-only handoff.

Open stacked PRs observed on 2026-09-17:
- PR #26 / Issue #2 — P1-01 scaffold/tooling — current known HEAD `b2f650351b473b49b8b893045a8b07c97882f9a0`;
- PR #49 / Issue #3 — P1-02 domain/channel contracts — stacked on #26;
- PR #50 / Issue #4 — P1-03 Prisma/Auth/tenancy — stacked on #49;
- PR #51 / Issue #5 — P1-04 BullMQ/delay — stacked on #50;
- PR #52 / Issue #6 — P1-05 webhook ingestion — current known HEAD `89502864a6bc77c3005543e2894d76399f13c1b8`, stacked on #51.

Fetch live HEADs before acting; the values above are a handoff snapshot, not immutable branch references.

## Immediate blocker — Issue #53 Business Profile sync

The open Phase 1 stack was implemented before the accepted `DATA_MODEL.md` v0.4 Business Profile architecture fully propagated into implementation.

Do **not** begin Phase 2 on the stale Workspace-only operational shape.

Current canonical model:
- Workspace = top tenant/billing boundary;
- Business Profile = operational/customer-data/privacy scope inside Workspace;
- one BP initially owns up to one Instagram + one WhatsApp account;
- Contact is canonical inside one BP by default;
- ChannelIdentity/Conversation/customer memory/search do not create a cross-BP graph by default;
- role answers **what** a member may do; BP scope answers **where**;
- BP-owned persistence should preserve Workspace + BP consistency, using direct IDs/composite FKs where this strengthens isolation;
- conversation state/version anchors support stale-action protection.

Issue **#53** and `docs/tasks/P1-BP-SYNC_CLAUDE_TASK_CONTRACT.md` govern the correction.

Correction order is mandatory:
1. PR #49 — domain/channel contracts;
2. propagate corrected #49 into PR #50, then fix DB/Auth/BP isolation;
3. propagate corrected #50 into PR #51, then fix BP-aware queue payloads/job IDs;
4. propagate corrected #51 into PR #52, then fix BP-aware webhook ingestion/outbox.

Preserve the existing stack with normal merge propagation. Do not force-push/rebase published branches just to clean the graph.

Every corrected PR must run complete branch-appropriate verification and publish:

`CLAUDE_READY_FOR_ASTRA head=<full_sha> task=<P1-xx>`

## Temporary Astra/Codex review protocol

Independent review is temporarily asynchronous because reviewer quota is constrained.

Claude should **not wait** for Astra after every iteration. Claude must:
- perform full self-verification and adversarial checks;
- record exact full HEAD SHA;
- leave `CLAUDE_READY_FOR_ASTRA` marker;
- continue to the next dependency-safe task.

This does not authorize Claude to merge its own feature PRs to `main`. Never claim Astra PASS unless that exact SHA was independently reviewed.

## Phase 1 exit

After Issue #53 corrections, do Issue #37 GitHub Actions `pnpm verify` gate when permissions allow.

Phase 1 is ready to hand into Phase 2 only when the corrected stack demonstrates:
- fake provider webhook -> verify -> normalize -> Workspace/BP-scoped persistence -> transactional outbox -> queue;
- PostgreSQL + Redis integration suites green;
- cross-Workspace and cross-BP adversarial isolation;
- duplicate/reordered webhook idempotency;
- human/manual echo fail-safe behavior;
- ambiguous external write never blind-retried;
- no LLM or artificial wait in webhook/request lifecycle.

## MVP build train after Phase 1

Follow Issue #61 / `CLAUDE_EXECUTION_QUEUE.md`.

### Stage B — Instagram + shared AI
Issues #8 -> #9 -> #10 -> #11 -> #12 -> #13 -> #14 -> #15 -> #16. Independent catch-up: #17.

### Stage C — reliability before broad AUTOPILOT
Issue #56: health, backpressure, kill switches, reconciliation, safe recovery.

### Stage D — Design Partner UI
#27 app shell/onboarding -> #58 EN/RU localization -> #28 Inbox -> #29 Review/conversation ops -> #31 Knowledge -> #32 Style -> #30 AI Settings/Test Drive -> #33 Leads -> #54 identity/memory -> #55 goals/followups/tasks -> #34 Analytics/Audit -> #35 UX E2E. Independent catch-up: #36.

A tightly controlled Instagram design partner may begin before the whole commercial MVP when the core UI, DRAFT path, kill switch, Knowledge/Style/Test Drive, and tenant/BP safety are green.

### Stage E — WhatsApp
#18 -> #19 -> #20 -> #21 -> #22 -> #23 -> #24. Independent catch-up: #25.

### Stage F — privacy/security
Issue #57 using `SECURITY_PRIVACY_RETENTION.md`.

### Stage G — commercial billing
#38 -> #43 -> #39 -> #40 -> #46 -> first provider/seller-route decision -> #41 -> #47 -> #42 -> #44. Independent catch-up: #45/#48.

Accepted commercial values are already in `PRICING_PACKAGING.md` v0.6 and Issue #43; do not reopen them during implementation unless the product owner changes them.

### Stage H — Admin Operations
Issue #59.

### Stage I — launch gate
Issue #60 using `LAUNCH_READINESS.md`, then independent-review catch-up and staged rollout to Commercial Beta.

## Accepted commercial snapshot

- Starter €49/mo or €490/yr;
- Growth €99/mo or €990/yr;
- Scale €249/mo or €2,490/yr;
- BP capacities 1 / 3 / 10;
- seats 1 / 5 / 15;
- voice 300 / 1,500 / 6,000 min/month;
- trial 14 days, no card, starts on first successful BP connection, 1 BP/3 seats/100 voice minutes;
- core AI customer-facing included/unmetered initially;
- voice is explicit metered resource with manual top-ups and no surprise auto-overage.

## MVP scope guard

Architecture is broader than the first commercial release. Do not delay MVP/Commercial Beta for:
- full Booking/calendar implementation;
- public Platform API/webhooks;
- broad CRM connector catalog;
- separate acquisition/prospecting product;
- Telegram/Threads;
- AI-generated voice/media replies;
- universal cross-BP identity graph.

These have designed extension points and can follow in V1.1/later unless a real design partner forces reprioritization.

## Hard invariants

Never trade these away for speed:
- Workspace + Business Profile isolation;
- human activity wins over AI;
- stale draft/review/action protection;
- model output is advisory; deterministic application policy authorizes sends/actions;
- no blind retry after ambiguous external write;
- provider/webhook/job idempotency;
- inbound persists even when AI/billing/dependency is blocked;
- AUTOPILOT is server-side and does not depend on open browser/dashboard;
- queues are execution mechanisms, not sole durable intent storage;
- secrets never enter prompts, ordinary logs, client output or plaintext audit.
