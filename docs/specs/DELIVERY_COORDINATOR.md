# Delivery Coordinator Specification — v0.1

## Purpose

Turn a policy-approved draft into exactly one safe platform-send attempt sequence while preserving human-like timing.

## Timing stages

1. **Inbound burst debounce**: sliding 7–12 second window; every newer inbound supersedes/reschedules the pending generation anchor.
2. **Post-draft human delay**: default configurable 30–120 seconds. MVP `Natural` profile samples a triangular distribution with mode around 60 seconds so most replies cluster away from the extremes. Persist the selected delay and `scheduled_for` before enqueue.
3. **Final revalidation** immediately before claiming/sending.

No request/webhook handler sleeps.

## Delivery state machine

Recommended durable states:

`SCHEDULED -> CLAIMED/SENDING -> SENT`

Terminal/hold branches:

- `CANCELLED_SUPERSEDED`;
- `CANCELLED_HUMAN_TAKEOVER`;
- `CANCELLED_POLICY`;
- `HELD_REVIEW`;
- `HELD_AMBIGUOUS`;
- `FAILED_RETRYABLE_EXHAUSTED`.

Names may be normalized during implementation but semantics must remain.

## Final pre-send revalidation

Immediately before an atomic send claim, check:

- no newer qualifying inbound after the draft anchor;
- no human/manual outbound or active takeover;
- conversation/account mode still AUTOPILOT and enabled;
- channel window still OPEN_FREEFORM/eligible;
- draft still policy-approved/current;
- account connected/credentials usable;
- operation has not already completed;
- scheduled job still owns the current reply cycle;
- rate/quota checks pass where applicable.

Any failed gate cancels/holds without sending.

## Atomic claim and idempotency

Exactly one worker/caller may transition a delivery from a claimable state into SENDING. Stable `operationId` and database constraints guard the logical action independently of BullMQ retries.

## Send result handling

- `ACCEPTED`: persist platform message ID, message record and SENT state.
- `REJECTED retryable=true`: bounded retry according to queue policy, provided current state still permits it.
- `REJECTED retryable=false`: hold/fail with provider code.
- `AMBIGUOUS`: move to `HELD_AMBIGUOUS`; never blindly auto-retry. Reconcile against webhook/conversation state or require human review.

Worker restart recovery must quarantine stale SENDING claims whose outcome cannot be proven.
