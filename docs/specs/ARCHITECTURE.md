# Target Architecture — v0.3

**Status:** Phase 0 frozen; Phase 2 design prepared while Phase 1 implementation is pending.

## High-level flow

```text
Meta Webhooks
  -> Channel Webhook Adapter
  -> Normalized Event Ingestion
  -> Conversation/Message Store
  -> Eligibility + Debounce Scheduler
  -> AI Draft Orchestrator
       -> factual knowledge retrieval
       -> style retrieval
       -> provider-neutral reply model
       -> structured-output validation
  -> Deterministic Policy Engine
  -> Draft Review OR Delayed Delivery Queue
  -> Delivery Coordinator
       -> final pre-send revalidation
       -> atomic send claim
       -> ChannelAdapter.send()
       -> Instagram API / WhatsApp Cloud API
  -> delivery/read/outbound-echo reconciliation
```

## Frozen technology baseline

- TypeScript / Node.js;
- Next.js 16 + React 19 for web/dashboard;
- pnpm workspace monorepo;
- PostgreSQL via Prisma 7;
- Redis/ioredis + BullMQ 5 for durable async work;
- Auth.js + Prisma persistence and WorkspaceMember tenancy;
- Zod for external/runtime schemas;
- Vitest for unit/integration tests;
- stateless web/API process separated from background worker process.

This supersedes earlier notes that Prisma vs Drizzle or BullMQ were pending choices.

## Core boundaries

### Channel adapters

Verify webhook authenticity, normalize provider events, expose capabilities, evaluate platform messaging windows, classify provider outcomes and send normalized outbound commands. They never call an LLM or decide business content.

### Conversation/application core

Owns channel-neutral state, idempotent event ingestion, contact/conversation lifecycle, AI-mode state, handoff state, scheduling and orchestration.

### AI draft orchestrator

Builds a versioned prompt/input package from: persona/goal, inbound bundle, bounded recent history, factual retrieval hits, style retrieval hits and channel hints. Calls a provider-neutral reply-model interface and validates the structured result. Model output is advisory; it never owns the final send decision.

### Retrieval boundary

Factual knowledge and style memory are separate stores/retrievers. Knowledge is authoritative for business facts; style examples only influence phrasing. Retrieval returns provenance IDs that are stored with every AI draft.

### Deterministic policy engine

Pure business-policy evaluation after generation. It decides HOLD / SCHEDULE / SKIP from current mode, model/schema validity, confidence, mandatory-review reasons, factual support, channel window, takeover state, account state, quiet hours and draft freshness.

### Delivery coordinator

Owns delayed delivery, final revalidation, atomic claim, normalized send outcome handling, reconciliation and no-double-send guarantees. `AMBIGUOUS` provider outcomes are quarantined, never blindly retried.

### Human handoff

Manual human activity always wins. A platform outbound echo that does not match a known app-originated platform message/operation is treated as a human/manual signal and pauses automation. Human-edited approved drafts may become style examples but not factual knowledge.

## Instagram MVP policy

- Professional Business/Creator accounts via Instagram API with Instagram Login.
- Conversations are user-initiated; no arbitrary cold follower DMs.
- Account/workspace chooses `STANDARD_ONLY` or `HUMAN_ASSISTED_EXTENDED` after-window behavior.
- `STANDARD_ONLY`: no send after the standard automated window until the user reopens it.
- `HUMAN_ASSISTED_EXTENDED`: AI may draft outside the standard window, but the extended Human Agent send requires an explicit real-human review/send action and current Meta eligibility/approval.
- The automated worker never silently applies `HUMAN_AGENT` merely to bypass the standard window.
- MVP auto-send content is text. Inbound media may be mirrored/represented but unsupported media understanding is held or escalated until dedicated vision/transcription support exists.

## Reliability invariants

- database is the durable source of record; queue is coordination, not memory;
- stable source-event IDs prevent duplicate ingestion;
- stable outbound operation IDs prevent duplicate logical sends;
- delayed work stores chosen delay and schedule durably;
- final gate always checks newer inbound, human takeover, current mode/window/account state and ownership of the reply cycle;
- concurrent workers cannot both claim a delivery;
- definite provider rejection may retry only when classified retryable;
- network ambiguity becomes `HELD_AMBIGUOUS` and reconciliation/manual review;
- provider-specific types do not leak into domain/application packages.
