# Reliability, Monitoring & Incident Behavior — Phase 5

## Principle

The product must fail safely, preserve inbound customer activity whenever possible, and degrade by capability rather than silently disabling an entire Business Profile.

AUTOPILOT is server-side and remains independent of browser/dashboard presence. Reliability behavior is driven by durable backend state, queues/workers, provider webhooks, reconciliation and current policy.

The system must never pretend that an operation succeeded when the authoritative provider/application state is unknown.

## Reliability priorities

When a dependency is degraded, prioritize in this order:

1. preserve/accept inbound customer events durably when the provider and persistence path allow it;
2. prevent duplicate or unsafe outbound side effects;
3. retain enough state to recover/reconcile later;
4. continue unaffected capabilities/conversations;
5. notify humans only when intervention is useful;
6. recover automatically where outcomes are definite and retry-safe.

## Capability-level degradation

Failures should be scoped as narrowly as possible.

Examples:
- AI provider unavailable: inbound conversations still persist; generation is delayed/held; manual human replies remain available if the messaging channel is healthy.
- Transcription unavailable or voice allowance exhausted: text handling continues; affected voice items remain visible and may require human handling.
- Calendar unavailable: normal conversation continues; booking actions hold/review instead of fabricating availability.
- One channel credential expires: that channel degrades; unrelated channels/Business Profiles continue.
- CRM/export connector fails: customer conversation should continue unless the missing integration is itself required for the requested action.
- Billing/entitlement state disables a paid capability: stop only the affected paid action according to `BILLING_ENTITLEMENTS.md`; preserve inbound/history.

A dependency failure must not automatically stop all AUTOPILOT activity unless correctness or tenancy cannot be guaranteed globally.

## Inbound durability

Provider webhooks/events must be acknowledged only after the system has reached the documented durable-acceptance point appropriate to the provider/transport.

If durable acceptance cannot be achieved, prefer provider-supported redelivery semantics over silently acknowledging and losing the event.

Use stable provider/source event IDs for idempotent ingestion. Replayed/reordered events must not create duplicate logical messages or duplicate actions.

The database is the source of record; queues coordinate work but are not the only copy of customer state.

## Queue / Redis degradation

If Redis/BullMQ is unavailable:
- do not lose already-persisted inbound messages;
- do not fall back to browser timers or in-memory-only schedules as authoritative state;
- mark/surface delayed work as pending/degraded;
- restore/reconcile durable scheduled work after queue recovery;
- never duplicate delivery merely because a job was re-enqueued.

Durable scheduling metadata must be reconstructable from PostgreSQL for critical workflows such as delayed sends, follow-ups and reconciliation.

## Database degradation

If PostgreSQL is unavailable or a transaction cannot be committed, the application must not claim durable success.

Do not send customer-facing side effects that require authoritative state if the state/claim cannot be persisted safely first.

Database recovery must not rely on React/browser state. Backups/restores should be tested periodically, and restored data must preserve idempotency keys, operation state and deletion/retention obligations.

## AI provider degradation

AI provider errors are classified at minimum as:
- retryable definite failure;
- non-retryable definite failure;
- ambiguous/unknown outcome where relevant;
- malformed/invalid model output.

Generation may retry with bounded backoff only when retry-safe. Never send a stale draft merely because generation later succeeds.

Before using a recovered/generated draft, re-check:
- latest inbound/human anchor;
- handoff state;
- Review blockers;
- current mode;
- channel eligibility/window;
- entitlement;
- Knowledge/Style versions where relevant;
- duplication/supersession state.

If the customer has sent newer messages while AI was unavailable, generate from the fresh bundled context rather than replying to an obsolete anchor.

Optional future model-provider fallback may be supported only through an explicitly configured provider-neutral policy. A fallback model does not bypass factual-support, safety, human-handoff or deterministic send gates.

## Messaging-channel degradation

Instagram/WhatsApp provider health is tracked independently per connection/capability.

Examples of degraded states:
- credential/token invalid;
- webhook delivery/auth issue;
- provider API unavailable/rate-limited;
- messaging-window/template restriction;
- send rejected;
- send outcome ambiguous;
- capability revoked/changed.

Definite retryable failures may retry with bounded backoff and the same logical operation identity where safe.

`AMBIGUOUS` sends are quarantined for reconciliation/manual Review and are never blindly retried.

A channel may enter a visible state such as `CONNECTED`, `DEGRADED`, `ACTION_REQUIRED`, `DISCONNECTED` without marking the whole workspace unhealthy.

## External write safety

Calendar, CRM, payment/customer-deposit and future integration writes use correlation/idempotency identifiers where supported.

If an external write times out after the request may have reached the provider, treat the result as unknown until reconciled. Do not issue a second create/refund/cancel/delete merely because the first response was lost.

High-impact writes should preserve enough metadata to reconcile against provider state without logging secrets.

## Backpressure and overload

The system must degrade predictably under traffic spikes.

Use queue depth/concurrency/rate limits rather than spawning unbounded work. Prioritize inbound persistence and existing customer conversations over non-urgent background work such as analytics aggregation or low-priority exports.

Delayed AI processing is preferable to dropping events or double-sending.

Where provider rate limits apply, respect retry-after/backoff semantics and avoid synchronized retry storms.

## Review and human attention during incidents

A technical incident should create human Review/attention only when a human can meaningfully act.

Examples:
- `DELIVERY_AMBIGUOUS` -> Review/reconciliation;
- expired channel credential -> owner/admin action required;
- calendar unavailable during active booking -> affected conversation Review;
- AI temporary retryable outage -> normally no immediate Review for every conversation; hold/retry and notify on sustained degradation or SLA breach;
- voice transcription outage -> affected media may be held/manual while text conversations continue.

Do not generate hundreds of duplicate Review/notification items for one shared provider outage. Deduplicate incident notifications and associate affected operations with the same incident/dependency state where practical.

## Product health UX

The owner needs a simple operational health surface rather than infrastructure jargon.

Recommended overall presentation:
- `All systems operational`;
- `Some features degraded`;
- `Action required`.

Per Business Profile / integration/channel, show useful states such as:
- Instagram — Connected;
- WhatsApp — Action required: reconnect;
- AI replies — Delayed;
- Calendar — Temporarily unavailable;
- Voice transcription — Available / allowance exhausted.

The Inbox should show local warnings in the affected conversation when relevant. Global incidents should use a compact banner/status center rather than repeating the same warning in every thread.

Do not show green/healthy solely because the browser is connected. Health comes from server-observed backend/provider state.

## Notifications and escalation

AUTOPILOT remains quiet during normal operation.

Notify humans for sustained or actionable reliability problems, for example:
- channel disconnected/auth expired;
- provider/webhook issue causing inbound/outbound risk;
- backlog exceeds configured threshold;
- delivery ambiguity requiring reconciliation;
- repeated AI generation failures preventing replies;
- calendar/payment/integration blocker on an active customer action;
- database/queue/platform incident materially affecting service.

Use existing notification importance levels and quiet-hour policy, but truly critical access/data-loss/channel incidents may bypass non-critical quiet suppression.

Deduplicate repeated alerts for the same incident and send recovery/resolution notifications only when useful.

## Monitoring / observability

Operational monitoring should cover at least:
- inbound event acceptance/failure rate and lag;
- duplicate/replay counts;
- queue depth, oldest-job age and worker availability;
- AI generation latency/error/invalid-output rate;
- delayed-send age and cancellation/supersession rate;
- outbound send accepted/rejected/ambiguous/reconciled counts;
- webhook/provider auth failures;
- channel connection/capability health;
- Review backlog and oldest actionable item;
- follow-up/booking overdue work;
- transcription/media processing failures;
- database/Redis connectivity and transaction/job failures;
- integration write failures/unknown outcomes;
- entitlement/billing transition errors.

Metrics/logs/traces must use correlation IDs without leaking message bodies, secrets, tokens or unnecessary personal data.

## SLO direction

Define service-level objectives before public scale rather than relying on generic uptime alone.

Useful product SLOs may include:
- durable inbound acceptance availability;
- p95/p99 inbound-to-processing lag;
- p95 AI-ready response latency excluding configured human-like delay;
- delayed-send schedule accuracy;
- duplicate logical send rate (target effectively zero);
- unresolved ambiguous-delivery age;
- channel/webhook freshness;
- restore/recovery objectives for critical data.

Exact launch targets should be chosen from measured production behavior and provider limits rather than invented before load testing.

## Incident state / event model

Maintain durable internal incident/degradation records for material shared failures.

Conceptually an incident may include:
- scope: provider / workspace / Business Profile / channel connection / integration / capability;
- type/reason;
- severity;
- detected_at;
- last_observed_at;
- status `OPEN | RECOVERING | RESOLVED`;
- affected capability set;
- human action required flag;
- correlation/provider references without secrets;
- resolution metadata.

Shared dependency incidents may link many affected operations without creating one owner notification per operation.

## Recovery / reconciliation

Recovery is not just "dependency is green again". After an outage, workers must reconcile unfinished durable work.

On recovery:
- reload pending durable operations;
- re-evaluate stale anchors and supersession;
- verify ambiguous external outcomes before retry;
- re-check current authorization, handoff, channel window, entitlement and Business Profile status;
- cancel obsolete follow-ups/reminders/drafts;
- resume only work that is still valid;
- record recovery/reconciliation outcome.

Never perform a mass replay of stale customer sends simply because service returned.

## Deployments and schema changes

Deployments should preserve in-flight work and support safe rolling restart of web/workers.

Workers should stop taking new work, finish/return claims safely where practical, and never create duplicate sends during restart.

Database migrations should be backward/forward compatible across the intended rolling-deploy window where possible. High-risk migrations need backup/rollback or explicit recovery planning.

## Incident runbooks

Before production scale, maintain short operator runbooks for at least:
- Meta/WhatsApp/Instagram outage or credential revocation;
- AI provider outage/high error rate;
- PostgreSQL failure/restore;
- Redis/queue failure/rebuild;
- webhook signature/auth failures;
- delivery ambiguity spike;
- accidental notification storm;
- billing entitlement reconciliation issue;
- calendar/integration write ambiguity;
- suspected tenant-data access incident.

Runbooks must distinguish safe automatic retry from operations that require reconciliation/manual action.

## Testing

Reliability tests should include fault injection/adversarial cases, not only happy paths.

Examples:
- duplicate/reordered webhooks;
- process crash between DB claim and provider call / provider call and result persistence;
- provider timeout after possible acceptance;
- Redis outage while delayed sends exist;
- new inbound arriving while AI request is in flight;
- human takeover while a send is delayed;
- calendar booking conflict between lookup and create;
- expired token during active conversation;
- restored service with stale queued drafts;
- two workers racing the same operation.

The acceptance goal is not merely "eventually works"; it is "no lost durable customer state, no unauthorized cross-tenant behavior, and no duplicate/unsafe side effect."

## Audit

Audit material reliability/admin actions such as:
- manual reconciliation result;
- forced retry/resume/cancel;
- credential reconnect/disconnect;
- incident acknowledgement where relevant;
- operator override of a held action;
- recovery of a quarantined send/booking/payment action.

Do not copy private customer content or secrets into reliability audit records.

## Product-owner decision: unmatched outbound echoes

For MVP, an unmatched outbound echo is **not** sufficient evidence to settle an ambiguous automated send as `SENT`.

Preserve ADR-013 semantics:
- correlated echo -> settle the known operation;
- unmatched echo -> treat as native/manual human activity and pause automation;
- ambiguous operation with no authoritative correlation -> remain quarantined/reconciliation-required and escalate to a person when needed;
- never blind retry.

ADR-017 records the rejected optimization and its revisit criteria. Human-takeover safety wins over reducing false-positive Review work.
