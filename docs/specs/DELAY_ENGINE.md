# Human Delay Engine — v0.2

## Objective

Avoid robotic instant replies while preventing stale answers and preserving reliability.

## Stage A — inbound debounce

Initial configurable target: 7–12 seconds after the latest inbound message in a burst.

If another inbound arrives before firing, the prior debounce job becomes stale/superseded. The newest message owns the reply cycle and draft context includes the recent burst.

## Stage B — post-draft delivery delay

After generation and initial gates, schedule delivery with an initial configurable range of 30–120 seconds. Do not sleep in a request/worker thread; persist/schedule a durable job.

The production distribution should not look uniformly mechanical. Exact distribution parameters are configuration, not hardcoded business logic.

## Final pre-send gate

Immediately before adapter send verify all of the following:

- job/draft still owns the current reply cycle;
- no newer inbound superseded anchor context;
- no verified human reply/takeover;
- conversation/account mode still allows automation;
- draft was not dismissed/edited/replaced;
- channel service/policy window still allows this message type;
- account credentials/connection remain valid enough to attempt send;
- idempotency guard confirms this outbound operation has not completed.

Failure cancels/holds/rebuilds according to reason; stale content is never sent merely because a timer expired.

## Delivery concurrency

A delivery job must atomically claim the send operation. Only one worker can own a draft send. After claim, record attempt/correlation/operation ID before or atomically with outbound state transition as architecture permits.

## Ambiguous outcome

If transport times out after a request may have reached Meta and delivery status is unknown, mark `HELD_AMBIGUOUS` and reconcile. Do not automatically resend and risk duplicate customer messages.

## Human takeover race

Queue cancellation is best-effort only. Final DB-backed takeover/revision checks are authoritative, so an already-running worker still cannot send after a human reply.

## Configuration

Workspace/account may configure debounce, delay range, quiet-hours policy and takeover duration within product safety bounds. Per-conversation override is allowed where defined by policy.

## Implementation notes (P1-04)

`packages/queue` implements the channel-neutral queue primitives for this spec on BullMQ 5 with Redis. Business handlers (ingestion, AI drafts, the delivery coordinator) plug into `QueueHandlers` later.

**Queues and jobs.** `families.ts` is the single registry. Every payload has `schemaVersion`, `workspaceId`, `businessProfileId` and `correlationId`, is validated with strict Zod schemas when enqueued and again when processed, and carries identifiers only (no message text). Business Profile scope (Data Model v0.4, Issue #53) was added to the unreleased `v1` envelope in place: payloads without it are rejected. The queue does not authorize anything; workers revalidate scope against PostgreSQL.

| Queue | Job name | Deterministic job ID | Retry policy |
| --- | --- | --- | --- |
| `inbound-debounce` | `inbound-debounce.v1` | workspace + Business Profile + conversation + anchor message | 3 attempts, exponential from 1 s |
| `media-transcription` | `media-transcription.v1` | workspace + Business Profile + `messageId` | 4 attempts, exponential from 15 s (terminal failures are recorded, never thrown) |
| `ai-draft-generation` | `ai-draft-generation.v1` | workspace + Business Profile + conversation + anchor message (+ `requestId` for manual requests) | 3 attempts, exponential from 5 s |
| `presence` | `presence.v1` | workspace + Business Profile + `operationId` | **1 attempt**: an announcement is worthless once the reply has arrived |
| `delivery` | `delivery.v1` | workspace + Business Profile + `operationId` | up to 3 attempts, **only** for explicit not-sent outcomes |
| `delivery-reconciliation` | `delivery-reconciliation.v1` | workspace + Business Profile + `operationId` | 5 attempts, exponential from 30 s (lookups only, never a send) |

- **Job ID format.** Job IDs join URI-encoded parts with `|`, because BullMQ rejects `:` and integer-like IDs.
- **Duplicate enqueues.** Adding work with an existing job ID is a no-op. Completed jobs are kept for 7 days and failed jobs for 30 days, so that dedupe window lasts at least that long. PostgreSQL operation records remain the authoritative idempotency guard (ADR-012).
- **Invalid jobs.** A malformed payload or unknown job name/version fails the job without retries and without calling a handler; logs contain field paths only.

**Debounce supersession (Stage A).** `scheduleInboundDebounce` does two things:

1. It enqueues the job for the new anchor.
2. It atomically claims the conversation's reply cycle in Redis (a Lua compare-and-set on anchor time, then message ID), keyed by Workspace + Business Profile + conversation so identical IDs in different profiles never interact. The outcome is one of:
   - A newer anchor supersedes the previous one, whose delayed job is removed on a best-effort basis.
   - A late, older inbound message is `STALE` and its job is removed.
   - A redelivered inbound message for the same anchor is idempotent.

A superseded job that still wakes up checks ownership, completes as `SUPERSEDED` and never calls the handler. If the Redis marker expired, ownership is `UNTRACKED` and the database checks decide.

**Delayed delivery (Stage B).**
- `planDelay(range, now, random)` samples inside the configured range (for example `DEFAULT_DELIVERY_DELAY_MS`, 30–120 s).
- `scheduleDelivery` stores `scheduledFor` and `selectedDelayMs` in the payload and uses a BullMQ delayed job.
- Nothing sleeps in a request or worker thread, and the job survives producer or worker restarts. Redis runs with append-only persistence in `compose.yaml`; production Redis must be persistent too.
- Distribution shaping beyond uniform sampling is left to policy configuration in Phase 2.

**Delivery outcomes (ADR-012).** The delivery handler returns one of:

- `SEND_RESULT` with the adapter's `SendResult`:
  - `ACCEPTED` → `SENT`.
  - `REJECTED` with `retryable: true` → queue retry. The provider explicitly did not accept the message.
  - `REJECTED` with `retryable: false` → `REJECTED`.
  - `AMBIGUOUS` → `QUARANTINED`: a `delivery-reconciliation` job is enqueued and the delivery job completes. It is never retried.
- `SKIPPED` → no longer owns the send; nothing was sent.
- `NOT_CLAIMED` → nothing was sent; retries only if `retryable` is set.

Any of the following is treated as an unknown outcome, quarantined for reconciliation and failed without retries:
- the handler throws;
- the handler returns an unreadable result;
- the reconciliation enqueue itself fails.

Delivery workers run with `maxStalledCount: 0`. A delivery whose worker died or lost its lock mid-run is failed instead of re-run, and a reconciliation job is enqueued with reason `DELIVERY_STALLED`.

**Worker lifecycle.**
- `apps/worker` validates `REDIS_URL`, starts one BullMQ worker per queue and logs enqueue and processing events with the queue name, job ID, workspace ID, Business Profile ID and correlation ID.
- On `SIGINT`/`SIGTERM` it closes gracefully and waits for running jobs.
- Redis outages are logged once, without the URL.
- Until the real handlers exist, jobs fail visibly without retries and delivery returns `NOT_CLAIMED`, so nothing is sent.

## Presence timing (P4-05)

A read receipt and a typing indicator are the one cosmetic thing this product does, and they are scheduled
*separately from the reply* — presence picks a moment inside the delay the delay engine chose, and can
never move, shorten or cancel a send.

- **The indicator is raised shortly before the reply, not when the delay starts.** The provider dismisses
  it when the reply arrives or after 25 seconds, whichever comes first, while this product's human-like
  delay is 30–120 seconds. Announcing at scheduling time would show it, drop it, and leave the customer
  watching nothing for a minute.
- **The lead is bounded three ways and the tightest wins:** the business's own setting, the provider's
  indicator lifetime, and the reply's own delay. A reply sooner than the lead is announced immediately.
- **A read receipt waits for nothing**, because it is a statement about a message that already arrived.
- **It is re-decided when it fires.** The announcement runs the same policy evaluation the delivery
  coordinator runs, against the same context, and says nothing unless the reply would still go out —
  cancelled, superseded by a newer customer message, taken over, switched off, suspended or disconnected
  all produce silence. A shorter list of conditions here would be a second definition of "still valid"
  that drifts from the real one.
- **It is never scheduled for a draft held for review**, and never for a channel this deployment cannot
  actually deliver on. The platform's own guidance is "only display a typing indicator if you are going to
  respond".
- **No blocking sleeps anywhere.** The announcement is a delayed queue job, the same durable primitive the
  reply uses.
