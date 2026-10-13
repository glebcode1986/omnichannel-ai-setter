# Conversation goals, next actions, follow-ups and human tasks

**Status:** Implemented by P3-02 (Issue #55).

**Related:** `DATA_MODEL.md`, `POLICY_ENGINE.md`, `HUMAN_HANDOFF.md`, `DELIVERY_COORDINATOR.md`, ADR-004
(deterministic gates), ADR-012 (ambiguous sends), ADR-014 (send authority).

**Written for this task.** Issue #55 referenced this document and the repository did not contain it. It
records what was built; where it settles something the issue left open, the section says so.

## The brief, in the issue's own words

> Add bounded goal execution and follow-up automation **without turning the product into an unlimited
> outreach engine**.

Everything below is arranged so the unlimited version cannot be built by accident.

## Four concepts, deliberately four

| | What it is | What it cannot do |
| --- | --- | --- |
| **Goal** | What this conversation is for | Carries no schedule. Cannot cause a message. |
| **Next action** | The immediate step a person intends | Schedules nothing. |
| **Follow-up** | One scheduled attempt to message the customer | Carries no message. Cannot send by itself. |
| **Human task** | Work for a person | Cannot message anybody, at all, ever. |

Collapsing any two produces the product this issue exists to prevent:

- a goal that implied a schedule would chase customers **by existing**, and the decision to message
  somebody would be made by whoever set the goal rather than by the gates;
- a follow-up that doubled as a task would make "mark done" a send button;
- a task that could send would be an outreach queue wearing a to-do list's clothes.

### Next action: on the conversation, not in a new table

`conversations.next_action` and `next_action_at` already existed from the leads work (P5-07). A lead's
"what happens next" and a conversation's are the **same question**, and a second place to answer it would
give two answers — with the one an operator saw depending on which screen they opened.

So `setNextAction` writes those columns. That is a deliberate reuse, not an omission: the issue asks for
NextAction to be *separate from* the goal and the follow-up, and on the conversation it is separate from
both. It also avoids changing core entity semantics, which would need an ADR.

## Goals

`conversation_goals`: one row per goal, with history.

- **One active primary goal per conversation**, enforced by a partial unique index. Two would be two
  answers to "what are we trying to do here", and the assistant would pick one at random.
- **A model may propose; only a person sets.** `suggestGoal` always writes `is_primary = false` and
  `source = AI_SUGGESTED`, and a CHECK requires it to name the draft it came from. `setPrimaryGoal` writes
  `HUMAN_SET` and a CHECK requires the person's id. This is the same rule as customer facts
  (`CUSTOMER_IDENTITY_SEARCH.md`) and for the same reason.
- **Retiring a goal keeps it.** The old goal becomes `ABANDONED` rather than disappearing: what a
  conversation *used* to be for is how somebody later understands a follow-up that went out under it.
- **`ACHIEVED` and `ABANDONED` are both terminal and not the same fact.** One is a success worth counting,
  the other a decision worth reviewing. A CHECK pairs each status with its own timestamp, and refuses a
  row claiming both.
- **`NONE` means explicitly nothing further**, and cannot be "achieved" — a CHECK says so. Allowing it
  would let a follow-up be justified by a goal saying there is nothing to follow up about.
- `conversation_goals` has **no** `due_at`, `attempt_count` or `scheduled_for`. There is a test asserting
  that absence.

Retiring or closing a goal settles its pending follow-ups **in the same transaction**. "Goal achieved
cancels pending work" is one of the issue's required behaviours, and doing it here means the cancellation
is a fact the moment somebody records the outcome — not something the next worker happens to notice.

## Follow-ups

`follow_ups`: one row per scheduled attempt.

### It carries no message

A follow-up records *that* we intend to follow up, against which state, for which goal, and by when. At
execution it asks for a reply through the path every automated send already uses. **There is no second
send path.** Nothing in `followup-store.ts` touches a provider; `claimFollowUp` returns a decision and the
composition root hands a `READY` claim to the shared delivery coordinator, which applies the policy gates
exactly as it does for any other automated send.

### What the claim asks the channel

`CHANNEL_INELIGIBLE` has always been documented as "window closed, template required, account unhealthy",
and for a while only the last of those was asked. So the claim now also asks whether **any** route could
carry the message at all: the provider's messaging window, and the profile's own after-window choice.

It asks through an injected port, because a messaging window is a provider fact and `packages/db` imports
no channel adapter — and it asks inside the claim's transaction, with the facts read under the conversation
lock, because a window is computed from a timestamp another transaction may be writing.

**The port can never permit a send.** Every send is still decided twice downstream, at the disposition and
again at the final pre-send gate, so a `false` only declines to spend an attempt and a model call on a
follow-up nothing could have delivered, and a `true` means no more than "ask the engine". That asymmetry is
what lets it fail open for a channel it has nothing to say about, and it is why it answers `false` only
where there is provably no route: outside the window on `STANDARD_ONLY`, or in a conversation the customer
never started. Outside the window on `HUMAN_ASSISTED_EXTENDED` it answers `true`, because that route ends
in a person's decision and taking that decision away from them is not this gate's business.

### It answers nothing, so the automated-response budget does not apply to it

One gate needs saying out loud, because "exactly as for any other automated send" reads the wrong way for
it. Meta's automated-response budget — `INSTAGRAM_ADAPTER.md`'s "no later than about 25 seconds after the
latest **triggering inbound**" — is a rule about answering a person promptly, and it is counted from their
message. A follow-up exists precisely because they stopped writing: its anchor is hours or days old by
design, so a budget measured from it is always already spent.

Applied anyway, it sent every follow-up to `DEADLINE_MISSED`, which asked a person to review a message
nobody is waiting for and left the attempt to be settled `REVIEW_PENDING` by the next claim. The feature
could be wired up correctly end to end and still never send anything.

So a send that answers no inbound message declares itself `proactive` and carries no dispatch deadline.
The rule that *does* govern it is the provider's standard messaging window, still computed from the
customer's own last message — a follow-up outside the 24-hour window is refused by the window gate exactly
as any other send would be, and every other gate is untouched. The flag is set only where it is true, so a
send that forgets to declare itself keeps the deadline and is held rather than quietly losing a provider
rule.

### Attempts are bounded in the database

```sql
CHECK (max_attempts BETWEEN 1 AND 5 AND attempt_count >= 0 AND attempt_count <= max_attempts)
```

Default 3, hard ceiling 5. Past five, the difference between following up and harassing somebody is a
matter of opinion, and this product does not get to hold the opinion. `boundedMaxAttempts` clamps a
caller's request rather than erroring, and the CHECK is what survives a migration or a console session.

`EXHAUSTED` is the only status that may carry `MAX_ATTEMPTS`, and `MAX_ATTEMPTS` may appear on no other
status — a CHECK holds both directions. The bound is checked **before** the attempt is spent; checking
afterwards would allow one more than the maximum, which is the off-by-one that turns three into four for
every customer.

### The queue is never the source of truth

The row is. `dueFollowUps` rebuilds the work from the table, so a queue that lost its contents does not
lose the intent. The acceptance criteria state this directly, and the queue remains what it is elsewhere
in this product: an execution mechanism.

### Everything is revalidated at execution

`claimFollowUp` re-reads all of it inside one transaction:

| Checked again | Stop reason | Status |
| --- | --- | --- |
| Conversation still open | `CONVERSATION_CLOSED` | `CANCELLED` |
| Goal still active, still not `NONE` | `GOAL_TERMINAL` | `CANCELLED` |
| No human takeover | `HUMAN_TAKEOVER` | `CANCELLED` |
| Customer not opted out | `OPTED_OUT` | `CANCELLED` |
| Scope not suspended | `OPTED_OUT` | `CANCELLED` |
| Entitlement and the conversation's AI switch | `ENTITLEMENT_LOST` | `CANCELLED` |
| Channel account healthy | `CHANNEL_INELIGIBLE` | **`BLOCKED`** |
| No newer inbound message | `NEW_INBOUND` | `SUPERSEDED` |
| State version matches the anchor | `STALE_ANCHOR` | `SUPERSEDED` |
| No unresolved review | `REVIEW_PENDING` | `CANCELLED` |
| Attempts remaining | `MAX_ATTEMPTS` | `EXHAUSTED` |
| Inside the profile's daypart | — | **deferred**, still `PENDING` |

`BLOCKED` is distinct from `CANCELLED` on purpose: blocked means a gate refused it *this time*, which is
something an operator may want to look at; cancelled means it will never run.

**New inbound and stale anchor are two checks, not one.** The state version moves for reasons other than a
customer message, and an inbound can arrive without anything else changing. Either check alone would miss
half the cases.

### Two locks, in a fixed order

`claimFollowUp` locks the **follow-up row** with `FOR UPDATE` before reading anything from it, then the
**conversation row**.

- The follow-up lock exists because reading first and locking second was a real bug: the attempt count
  came from a snapshot taken before the lock, so two workers racing for one follow-up both saw zero
  attempts spent, both passed the bound, and the customer got two messages.
- The conversation lock is the same boundary `appendInboundMessage` and the delivery claim take. Without
  it the revalidation reads its own snapshot and serializes against nothing: a customer message committing
  after that snapshot would be invisible, and the follow-up would go out behind it.
- The order is fixed so two claims in one conversation cannot deadlock by taking them the other way round.

### A successful claim takes a lease

`claimFollowUp` moves `due_at` forward by `FOLLOW_UP_CLAIM_LEASE_MS` (5 minutes) when it returns `READY`.
That is what makes a claim exclusive — a second worker finds the follow-up not yet due and leaves it
alone — and it is the recovery mechanism: a worker that died between claiming and sending leaves a row
that becomes claimable again once the lease lapses, **with the attempt it spent still counted**.

### Business Profile-local timing

The daypart is the **business's** window in the **business's** zone, stored on the row: when a business is
willing to message people is its decision, not the server's and not the customer's. Hours are half-open,
`[start, end)`, and may wrap past midnight. A zero-width window sends nothing — `planFollowUp` refuses
one, a CHECK refuses one, and `isWithinDaypart` returns false for one. The other reading ("start equals
end means all day") would turn a misconfiguration into unattended messages at three in the morning.

Outside the window a claim **defers** rather than stops: the follow-up is still wanted, just not now.

### One pending follow-up per conversation

A partial unique index, because the race it prevents is two workers planning at the same moment and only
the database can see both. Two pending follow-ups would be two messages about the same silence.

### Opt-out

`followup_suppressions`, its own table rather than a boolean on the contact, because it is a **claim with
provenance**: who recorded it, when, and on what evidence. A boolean would answer "may we message them"
without ever answering "who decided that", and an opt-out somebody cannot account for is one they cannot
defend.

Scoped to the Business Profile like every other customer fact: a person who opted out of one business's
follow-ups has said nothing about another's. **Only a person lifts one** — a CHECK requires the lifter's
id, and nothing expires on its own, because a suppression that lapsed would resume messaging somebody who
asked us to stop.

## Human tasks

`human_tasks`: work for a person.

### A task names only people its Business Profile may know about

An assignee must be a current Workspace member authorized for *this* Business Profile — checked on both
paths that set one, because a guard on one of the two is a guard on neither. Membership alone is not the
test: a member whose scope is `SELECTED` without this profile is as unable to act as a stranger.

That closes the door; the read closes the window. A grant can be revoked after an assignment was made, and
a row can predate the gate, so a profile-scoped task list resolves an assignee's identity **through the
grant as it stands now**, every time it is read, rather than trusting what was authorized when the row was
written. A name outside the profile is withheld while the id is kept: an operator still sees that the task
is parked on somebody who cannot do it, which is what they need in order to take it back, and they learn no
stranger's name doing so. The same rule covers whoever closed the task — one rule for every identity a
scoped read carries, not just the one the review happened to name.

**Completing or dismissing a task never sends a customer a message.** That is not enforced by a check in
`completeTask`, because a check can be moved. It holds because the table has **no** `draft_id`, no
`operation_id`, no delivery relation and no message text — there is nothing for a send path to attach to.
A future writer who wanted "mark done" to deliver something would have to add a column and argue for it in
a reviewed diff.

Tests assert that absence directly, by reading `information_schema`, and separately assert that completing
a task changes no message, delivery, draft or outbox row and does not touch the conversation's takeover,
mode, state version or AI switch.

This is why a task is the **safe** place for a model to propose work. `source_draft_id` records which reply
suggested one, and a model raising fifty tasks is fifty things in somebody's queue rather than fifty
messages to customers.

A dismissal must say why: a decision with no reason is one nobody can review.

## What may the model do?

The issue names `AI_ACTION_APPROVAL_MATRIX.md`, which the repository does not contain and which this task
has not invented wholesale — a matrix for every AI action across the product is a larger document than
this work justifies. For the actions **this** task introduces, the matrix is:

| Action | Model may | Person must |
| --- | --- | --- |
| Suggest what a conversation is for | yes, as a secondary `AI_SUGGESTED` goal naming its draft | set the primary goal |
| Set the primary goal | **no** | yes |
| Mark a goal achieved or abandoned | **no** | yes |
| Set the next action | **no** | yes |
| Plan a follow-up | **no** | yes |
| Cancel a follow-up | no (the gate settles them automatically, with a reason) | may cancel explicitly |
| Raise a human task | yes, naming its draft | — |
| Complete or dismiss a task | **no** | yes |
| Send anything | **no** — only the shared delivery coordinator sends | approve, per ADR-014 |

`planFollowUp` reads `is_primary` precisely so a model's suggestion cannot justify messaging somebody.

## What was not built

- No UI. The issue's acceptance criteria are about durable state, the coordinator and safe cancellation;
  the surfaces that consume these primitives are separate tasks.
- No follow-up *content* generation. The claim returns the goal, and the existing draft pipeline produces
  the reply through the existing gates.
- No automatic opt-out detection from message text. Recording an opt-out is an explicit act with
  provenance; inferring one from a phrase is a classifier, and a wrong answer in either direction is bad
  in a way this task should not guess at.
