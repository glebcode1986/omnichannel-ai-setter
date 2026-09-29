# Reliability, health and incidents

**Version:** 0.1 — implemented by Issue #56 (P3-03).
**Related:** ADR-003 (durable delayed delivery), ADR-004 (human override wins), ADR-012 (atomic claim and
ambiguous-send quarantine), ADR-013 (unmatched outbound echo), ADR-017 (proposed: echo attribution),
`DELIVERY_COORDINATOR.md`, `POLICY_ENGINE.md`, `DATA_MODEL.md` v0.4.

## What this is for

Before AUTOPILOT is pointed at paying customers, a failure has to be narrow, visible and safely
recoverable. Those three words are the whole specification:

- **narrow** — one expired credential stops one account, not a platform;
- **visible** — an operator can tell what is broken and what it is costing, without reading logs;
- **safely recoverable** — recovery never double-sends and never discards customer data.

Two properties are absolute, and every mechanism below is arranged around them:

1. **No dependency failure may silently double-send.** A send whose outcome is unknown is never retried
   (ADR-012). It is investigated, and when it cannot be resolved a person is told.
2. **No dependency failure may discard inbound customer data.** Inbound ingestion is never suspended,
   never rate-limited by backpressure and never gated on outbound health. A customer message that arrives
   during the worst outage is still stored.

## The kill switch

Automated outbound can be stopped deliberately, at four nested scopes: `GLOBAL`, `WORKSPACE`,
`BUSINESS_PROFILE`, `CHANNEL_ACCOUNT`. The widest active switch wins, and *which* one applies is part of
the answer — "paused for this account" and "paused everywhere" are different things to the person reading
the Inbox.

- **It stops outbound only.** Inbound keeps arriving and keeps being stored. The person pulling it is
  trying to prevent harm; a switch that also dropped customer messages would turn a precaution into data
  loss.
- **It is enforced in the policy engine**, as `AUTOMATION_SUSPENDED`, alongside every other gate. Not in a
  check closer to the wire: that is how a switch acquires a path around it. Every route to a send goes
  through the policy engine.
- **A suspended reply is held, not cancelled.** The operator stopped sending; they did not decide the
  reply was wrong. Holding also avoids the other failure mode — a stampede of accumulated replies the
  moment service is restored, which the coordinator re-judges one at a time on resume.
- **It is read with the state the claim binds, and re-asserted by the claim.** A switch is a decision
  about the system rather than a fact about one conversation, and that once seemed like a reason to
  resolve it separately, before the coordinator ran. It was not: a value read before the coordinator's own
  read cannot be re-asserted when the send is taken, so a switch turned on while a reply was being judged
  reached no guard at all and the reply went out behind the operator. The switch is now part of the
  coordinator's single guarded read, and the claim re-reads it inside its own transaction.
- **Turning a switch on is ordered against claims in flight, by the database.** `automation_suspensions`
  has no foreign key to the workspace, profile or account it names — and a `GLOBAL` switch names no row at
  all — so there is no parent row whose lock could order the two. An advisory key does it instead: a claim
  takes, in shared mode, every key that could cover it. **A trigger on the table takes the matching key on
  every insert, update and delete**, which is the only way the rule can bind the direct SQL an operator
  runs during an incident. Ordering it in a store method would bind callers who went through that method
  and nobody else — and this section says in the next bullet that writing to this table by hand is
  expected. Claims never block one another; a write waits for the claims already in flight and blocks the
  ones after it.

  The key is spelled twice, in the trigger and in `packages/db/src/suspension-lock.ts`, and a test asserts
  the two derivations hash identically. A mismatch has no symptom: the claim would simply never wait.
- **It is a record, not a flag.** Who, when, why, and who lifted it. Lifted switches are kept, because the
  question after an incident is always whether anyone turned it back on.
- **A narrow scope must name what it narrows to.** A `BUSINESS_PROFILE` row with no profile named would be
  a global stop wearing a contained-looking label; a CHECK constraint refuses it, because this is a table
  people write to by hand during an incident — the same reason the ordering above is a trigger and not a
  convention in application code.

The system may pull a global switch itself — currently only for `BACKLOG`, see below. System switches are
distinguishable from operator switches (no user attributed), and nothing automatic may extend, shorten or
end a switch a person pulled.

## Health

Component health is normalized to three states, and the distinction that matters is not how broken
something is but whether a person can act:

| State | Meaning |
| --- | --- |
| `OPERATIONAL` | Working. |
| `DEGRADED` | Working worse than usual, and nobody needs to do anything yet. |
| `ACTION_REQUIRED` | Stopped, and a person can fix it — reconnect an account, restore a key, clear a backlog. |

Components: `DATABASE`, `QUEUE`, `AI_PROVIDER`, `EMBEDDINGS`, `CHANNEL_ACCOUNT`, `TRANSCRIPTION`,
`INTEGRATION`. The single line above them is the worst component's state: a summary that averages away one
broken channel is wrong in the one direction that matters.

Rules:

- **Degrade by capability, not by tenant.** One expired Instagram credential makes that channel need
  attention. It does not make a Business Profile or the platform unhealthy.
- **Only two components block outbound by themselves**: the database, because nothing can be claimed
  durably without it, and the channel account being sent on. A failing model provider means no new drafts,
  which is a delay — and delay is the correct outcome there, not a halt of what was already approved.
- **Health is server-observed.** Nothing is inferred from a browser being connected.
- **No summary carries a secret.** Summaries are short fixed phrases. A probe that throws is reported as
  `unreachable`; the thrown value never reaches the surface, because a connection error's message
  routinely contains a host, a user and sometimes a password.
- **`since` is carried forward while a state is unchanged**, so "action required" and "action required for
  forty minutes" are distinguishable — only the second tells someone whether their fix worked.

## Reconciliation

A send whose outcome is unknown enters a durable record (`delivery_reconciliations`), written *before*
anything is examined. The queue is not the record: a Redis flush, an evicted job or a worker that dies
mid-investigation must not be able to make "we do not know whether the customer received this" disappear.

Order of resolution — our own durable state first, because it answers outright more often than a provider
can, and asking a provider is a chance to act on a stale answer:

1. the delivery is `SENT`, cancelled or already held → nothing is unknown; recorded as `ALREADY_SETTLED`;
2. the delivery is `SENDING` → a worker may still be alive. Reconciliation does not race it; the
   stale-claim sweep is what turns an abandoned claim into an ambiguity;
3. **no claim was ever taken** → the transport was never reached, so no send was attempted. This is the
   one provably safe resume, and it covers the most common outage shape: a worker that died before
   sending;
4. retries were exhausted → repeated refusals are not ambiguity. The customer received nothing, and
   whether the reply is still worth sending is a person's decision;
5. otherwise the provider is asked. `SENT` settles it with the platform's own identifier; `NOT_SENT`
   resumes; `UNKNOWN` waits out a grace period (a late echo usually settles it) and then tells a person.

**Recovery is reconcile → revalidate → resume, never queue replay.** "Resume" returns the operation to the
claimable state and re-enqueues delivery; the coordinator then re-reads the conversation and re-runs the
policy engine. A customer who lost interest during the outage does not receive an answer to a question
they have since withdrawn, and a conversation a human has taken over is not replied to by automation.

There is deliberately no resend anywhere in the reconciliation path. The only port that can reach a
customer is the delivery coordinator's.

### What the provider can actually tell us

For Instagram, nothing. Meta's Send API has no lookup from a request identifier to a message, so an
ambiguous send cannot be resolved provider-side, and the implementation answers `UNKNOWN` rather than
guessing. Two tempting alternatives are rejected:

- matching the reply's text against the thread — ADR-013 rules this out in as many words, and it breaks
  the moment two customers ask the same question;
- treating an unattributed outbound echo as ours — proposed and **rejected** by the product owner
  (ADR-017). An unmatched echo stays what ADR-013 says it is: native or manual human activity, which
  takes over the conversation. A missed takeover is not a review item saved, it is a window in which
  automation replies over a person who has already started answering.

So the settled rule is: a correlated echo may settle the operation it is correlated to; an unmatched echo
means takeover; an unresolved ambiguous send is quarantined, reconciled and then put in front of a
person; and a blind retry never happens.

## Backpressure and concurrency

A dependency storm is usually caused not by the first failure but by what the system does next: the
provider slows, jobs pile up, retries multiply, and the queue meant to smooth load becomes the thing
generating it.

**Concurrency limits** are per queue, because the queues have nothing in common but the process they run
in. Storing a burst of webhooks is cheap and touches only our own database; asking a language model is
expensive and rate-limited by tier; sending is bounded by the platform's own limits, and exceeding those
is charged to the account. Defaults are deliberately conservative and every one is overridable, because
the right value depends on the provider tier and the account.

**The backlog guard** watches outbound queues only, on two signals — depth, and the age of the oldest
waiting job. Age matters independently: twelve jobs whose oldest has waited eleven minutes is a queue that
has stopped, which depth alone will never show. When it trips, it pulls the system's global kill switch
with reason `BACKLOG`, reusing the one mechanism the policy engine already honours rather than inventing a
second path.

Two properties keep the guard from becoming its own problem:

- **hysteresis** — the level that trips it and the level that clears it are different numbers, so a
  backlog hovering on a threshold cannot make it flap;
- **a bounded stop** — every automatic suspension carries an `until` and is renewed while the backlog
  persists. A guard that dies during the outage cannot leave automation switched off indefinitely: nothing
  renewing it means resume, not stay down.

Inbound is never watched. A pile of customer messages waiting to be stored is a reason to hurry.

## Incidents and notification

Failures are folded by what a person would do about them — the component, the instance and the class of
failure — not by the conversation they happened in. One outage becomes one incident with a count, and the
count is what says how bad it is.

An incident is announced once, when it is sustained (many occurrences) **or** widespread (many affected
conversations). Either alone is enough: requiring both would stay silent through a long outage that
happened to affect one busy conversation. A single retryable blip is never announced — it will very likely
resolve itself, and alerting on it trains people to ignore alerts. An incident that stops recurring is
forgotten and says so, so the same outage next week is announced again rather than suppressed.

Failures that will be retried are still counted. A provider failing forty times and recovering on the
retry each time is a real outage; counting only final failures would hide it.

## Metrics

Read from durable state rather than from in-process counters, because a metric that resets on restart is
worst exactly when the process has been restarting:

| Metric | What it means |
| --- | --- |
| `unprocessedInboundEvents` | Webhooks accepted but never processed. A webhook that vanished is silent data loss. |
| `outboxPending`, `outboxOldestMs` | The transactional outbox's own backlog and its age. |
| `unusableGenerations` | Generations the model answered badly — a refusal, or output that failed validation. |
| `ambiguousOperations` | Sends whose outcome is unknown. |
| `reconciliationsNeedingHuman` | Sends a person now has to decide about. |
| `draftsAwaitingReview` | Work waiting on a human. |
| `deliveriesSending` | Work stuck mid-send. |
| `oldestOverdueDeliveryMs` | How late the most overdue scheduled delivery is. |

A provider that never answers is deliberately absent from that table. It leaves no draft row at all: the
generation job fails, is retried, and reaches an operator as an incident. Counting only what reached the
database, and counting it accurately, is better than a number that looks like total provider health and
silently is not.

Queue depth and queue age come from the queues themselves and are reported alongside. Health, metrics and
incidents are computed from one instant in one loop: a health line saying "all systems operational" beside
a metric showing four hundred unresolved sends is worse than either alone.

## Not in this version

Named so the gap is visible rather than assumed:

- **notification transport.** Incidents are emitted as structured events; delivering them to email, Slack
  or a pager is a separate integration;
- **an operator HTTP surface.** The dashboard reads the same numbers from PostgreSQL; the worker
  deliberately does not serve traffic, because that would be another thing to keep alive during the
  incidents it is describing;
- **transcription and third-party integration probes.** The component kinds exist; nothing produces them
  yet, because nothing in the product uses them yet;
- **provider-side evidence for Instagram.** There is none to have: Meta offers no lookup from a send
  request to a message, and the one available substitute was rejected on purpose (ADR-017).
