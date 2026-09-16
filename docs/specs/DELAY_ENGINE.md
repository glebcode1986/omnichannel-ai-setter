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
