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

**The claim is conditional on the state the revalidation was made against, not only on the delivery row.**
Revalidating and then claiming takes time, and the conversation does not wait: a newer inbound, a human
takeover, an automation-policy edit or a draft rewrite can commit in between. A claim conditional only on
the delivery's own status succeeds in all of those cases and sends on an approval that has already been
withdrawn — the delivery row was never what authorized the send.

**The claim serializes against the writers of those facts.** A conditional statement is not enough on its
own: under PostgreSQL's READ COMMITTED the joined rows are evaluated from the statement's own snapshot, so
a conflicting transaction can still commit after that snapshot is taken and before the claim commits, and
the claim would not see it. The claim therefore runs in a transaction that first locks the conversation row
— the same lock a writer takes before recording a customer message, and the same row a takeover updates —
and then the draft, the channel account and the automation-policy rows the decision read. Only then is the
conditional UPDATE evaluated. Whichever side takes the conversation's lock first happens first, and the
other sees the result: the claim and a conflicting change have a total order rather than a race.

Everything the revalidation judged comes from that one read. The limits and the mode are read from the same
policy rows the claim binds, and the live channel facts (window, human-support exception, dispatch deadline)
are derived from the same context rather than fetched separately, so nothing judged can describe a different
instant from what is bound.

The claim re-asserts, in the same statement that takes the send, every fact the revalidation rested on: the reply cycle (no qualifying inbound after the draft anchor), the conversation's own state
(takeover, AI enabled, open/closed, mode override, and its state version for anything else that moves),
the draft (text, review flag, and that it has not already produced a message), the channel account's
health, and the automation-policy rows the mode and limits were read from. A claim whose facts no longer
match is refused as **state-changed** rather than as a lost race: nothing is claimed, nothing is sent, and
no attempt is counted.

A refused claim is re-read and re-judged, and normally the change is exactly what now cancels or holds the
delivery. A bounded number of passes applies; past it the job returns to the queue rather than being
decided from a snapshot that is already old.

This binding reaches as far as the claim and no further. Once the claim succeeds the message is being
handed to a provider and cannot be recalled, which is why the binding belongs at the claim rather than
anywhere earlier.

## Send result handling

- `ACCEPTED`: persist platform message ID, message record and SENT state.
- `REJECTED retryable=true`: bounded retry according to queue policy, provided current state still permits it.
- `REJECTED retryable=false`: hold/fail with provider code.
- `AMBIGUOUS`: move to `HELD_AMBIGUOUS`; never blindly auto-retry. Reconcile against webhook/conversation state or require human review.

Worker restart recovery must quarantine stale SENDING claims whose outcome cannot be proven.
