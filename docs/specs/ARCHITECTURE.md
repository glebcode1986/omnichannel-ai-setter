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

## Implementation notes (P1-05): webhook ingestion

**Route.** `apps/web` serves `/api/webhooks/{channel}/{channelAccountId}` (GET for the subscription challenge, POST for events). The route is thin transport: it captures method, lower-cased headers, query and raw body bytes (max 1 MiB), takes or creates a correlation ID (`X-Correlation-Id`) and calls `ingestWebhook` from `@omnichannel/application`. Results map to HTTP responses:

| Result | HTTP response |
| --- | --- |
| `ACCEPTED` | 200 |
| `CHALLENGE` | 200 (text body) |
| `UNAUTHORIZED` | 401 |
| `INVALID_PAYLOAD` | 400 |
| unknown account, or no adapter for the channel | 404 (the two cannot be told apart from outside) |
| unexpected error | 500 (the provider retries; ingestion is idempotent) |

The channel adapter registry is empty until the Instagram (Phase 2) and WhatsApp (Phase 4) adapters register.

**Ingestion sequence** (`packages/application/src/ingestion`):

1. Validate the route parameters.
2. Resolve the channel account and, from it, its Workspace and Business Profile (system lookup; never from the URL or payload). Disconnected accounts count as not found.
3. Pick the adapter for that account.
4. `verifyWebhook`. Only a verified POST continues; nothing is normalized or stored before this.
5. `normalizeWebhook`.
6. Validate each event with the channel-core schemas and check that its `workspaceId`, `businessProfileId`, `channelAccountId` and `channel` all equal the resolved account's. Invalid events (`INVALID_EVENT`) and events outside that scope (`SCOPE_MISMATCH` with the mismatched field names) are logged (paths, codes and field names only) and skipped before any transaction opens, so they write nothing.
7. For each event, in one PostgreSQL transaction, with every read and write scoped to the resolved Workspace + Business Profile + account (composite keys and foreign keys include `business_profile_id`):
   - claim the source event (`inbound_events`, unique per workspace/Business Profile/account/source event, `ON CONFLICT DO NOTHING`). A duplicate stops here.
   - apply it:
     - **Inbound message:** find or create the channel identity by stable provider user ID on that account (a new identity gets a new Contact in the same Business Profile; the same provider user in another Business Profile is a separate Contact, never merged; usernames and display names are refreshed, never used as keys) and its conversation, insert the message (unique per platform message ID), advance the activity timestamps and the conversation `state_version` by one and, if the conversation is eligible (open, AI enabled, no takeover), add an outbox entry `INBOUND_DEBOUNCE` with the dedupe key `inbound-debounce:<workspace>:<business profile>:<conversation>:<message>` and a delay sampled from the debounce window. Business Profile status is not checked: inbound is always stored; AI and delivery revalidate later.
     - **Outbound echo:** if it matches an app-originated message (with `operation_id`) or a delivery job's platform message ID in the same Business Profile and account, it is our own echo. Otherwise it is stored as a HUMAN outbound message, `state_version` advances by one and the conversation moves to `HUMAN_ACTIVE` (`UNMATCHED_OUTBOUND_ECHO`, actor `NATIVE_APP`, paused for the takeover duration; an existing takeover is extended) (ADR-013/004).
     - **Delivery or read status:** lock the matched message row (`SELECT … FOR UPDATE`), then update its status, moving forward only; `FAILED` applies only before delivery. The lock makes overlapping status webhooks for one message apply in order, so a slower `DELIVERED` can never overwrite a committed `READ`.
     - **Reactions, postbacks and policy events:** recorded as `IGNORED_UNSUPPORTED` for now.
   - store the outcome and correlation ID on the source-event row.

   `state_version` advances exactly once per newly stored participant message or unmatched human outbound, in the same transaction; duplicates (source event or platform message), own echoes, status events and identity refreshes leave it unchanged.
8. After commit, dispatch the new outbox entries to the queue (`scheduleInboundDebounce`) and return.

The webhook never calls a model and never waits: the debounce is a delayed BullMQ job.

**Consistency strategy: transactional outbox.**
- **Commit together.** Queue work is written to `queue_outbox` in the same transaction as the message it belongs to, so a stored message can never lose its reply cycle and a rolled-back message never schedules one.
- **Scoped rows.** Each entry carries `workspace_id` + `business_profile_id` (composite foreign key to `business_profiles`); a CHECK constraint (`queue_outbox_payload_scope_check`) requires the stored payload to name the same Workspace and Business Profile. The payload is the strict P1-04 `inbound-debounce.v1` job, so dispatch and recovery enqueue the same Business Profile scoped job ID.
- **Dispatch now, recover later.** Entries are dispatched right after commit. When enqueueing fails, the entry stays pending with backoff (`attempts`, `available_at`, `last_error_name`). The worker's outbox sweeper retries due entries every 5 s, under a lease (`locked_until`) so only one dispatcher owns an entry.
- **Late dispatch.** The debounce delay counts from when the entry was created, so a late dispatch fires sooner rather than restarting the window.
- **Duplicates are harmless.** A duplicate dispatch is a no-op: queue job IDs are deterministic and the reply-cycle claim is idempotent (DELAY_ENGINE.md, P1-04 notes).
- **Duplicate webhooks never create another outbox entry or reply cycle:**
  - source events are unique;
  - platform message IDs are unique;
  - outbox dedupe keys are unique;
  - concurrent deliveries resolve through `ON CONFLICT DO NOTHING`, so no transaction aborts.

**Correlation.** The route's correlation ID is attached to every ingestion log entry, stored on `inbound_events.correlation_id` and `queue_outbox.correlation_id`, carried in the debounce job payload, and logged by the queue producer and worker.
