# Launch Readiness / QA / Release Gates

**Status:** Accepted product/architecture contract for Commercial Beta launch.

## Principle

Production release is an exact-SHA decision supported by reproducible evidence. “Looks fine” is not a launch criterion.

MVP scope may be narrow, but safety-critical foundations are not optional cuts.

## Release severity

- `BLOCKER` — production release prohibited.
- `HIGH` — affected autonomous capability remains disabled until fixed.
- `KNOWN_LIMITATION` — release may proceed only if the limitation is explicit, bounded and safe.
- `PASS` — required gate satisfied.

## 1. Exact release SHA / CI

A release candidate is one immutable commit SHA. Required automated verification includes repository install reproducibility, typecheck, lint/architecture boundaries, tests, build and required infrastructure-backed suites.

Do not rely on “Claude ran it locally” without recorded commands/results. Independent Astra/Codex status is tied to exact HEAD SHAs; never transfer a PASS from an older SHA to a newer one.

## 2. Production-like staging

Maintain a staging environment separated from production with independent PostgreSQL, Redis, object storage, webhook endpoints, OAuth/provider credentials and test Business Profiles.

Automated tests should not require production Meta credentials, but pre-launch smoke testing includes real/sandbox provider flows where supported.

## 3. Messaging E2E matrix

Required scenarios for enabled channels include:
- normal inbound -> AI reply;
- burst/debounce handling;
- newer inbound after draft creation;
- duplicate webhook;
- reordered sent/delivered/read events;
- human takeover immediately before scheduled send;
- explicit Resume AI;
- DRAFT edit/send;
- stale Review action;
- channel/account disconnect;
- provider rejection;
- ambiguous network/send outcome.

No scenario may create a silent duplicate customer send. Ambiguous outcome goes to reconciliation, never blind retry.

## 4. AUTOPILOT with dashboard closed

Explicitly test the product with dashboard/browser closed:

customer inbound -> provider webhook -> durable persistence -> debounce -> retrieval/AI -> policy -> durable delay -> final revalidation -> send/status handling.

Reopening the UI later must reconstruct authoritative state. Browser/phone presence is not an execution dependency.

## 5. AI regression/evaluation gate

Maintain fixed synthetic/golden conversations covering representative business/support/booking-like interactions and safety boundaries.

Include normal factual question, missing/expired fact, complaint/refund, unusual discount/condition, human request, mixed language, multiple-message burst, prompt-injection attempt, unsupported/failed media, sensitive/style boundary and stale-context cases.

Deterministic policy assertions are separate from subjective reply-quality scoring.

## 6. Knowledge / Style gate

Verify:
- deleted/superseded/expired Knowledge is not retrievable;
- BP/workspace Knowledge cannot leak across scope;
- Style cannot authorize facts or change deterministic policy;
- Style examples do not become Business Knowledge;
- no trusted factual source -> clarify/review rather than model-memory fabrication.

## 7. Human / Review race gate

Adversarially test:
- AI draft while human begins/sends;
- native/manual outbound echo;
- new customer inbound while Review is open;
- approval after anchor/state changed;
- double-click/double-submit;
- takeover during post-draft delay.

Human activity wins. Stale approvals/drafts cannot execute.

## 8. Tenant / Business Profile isolation gate

Create multiple Workspaces and multiple BPs and attempt unauthorized access by IDs, filters, search, list endpoints and mutation paths.

Unauthorized callers must not discover record existence. Test Contact, Conversation, Lead, Knowledge, attachment/media, Review, analytics and operational records as those features exist.

## 9. Reliability / chaos gate

In staging intentionally fail or disable dependencies such as AI provider, Redis/queue, channel credential, transcription, calendar/integration (if enabled), object storage and selected workers.

Expected behavior:
- inbound persists when possible;
- unrelated features/channels continue;
- unknown external writes do not retry blindly;
- returning dependencies trigger reconcile -> revalidate -> resume;
- stale queued work does not execute merely because a service returned.

## 10. Load / concurrency gate

Test bursts above expected initial customer traffic, focused on correctness rather than vanity throughput:
- webhook ingestion;
- queue backlog/oldest age;
- DB transaction contention;
- atomic delivery claims;
- duplicate workers;
- AI/transcription concurrency and provider rate limits.

Under overload the system may slow down, but must not lose inbound or double-send.

## 11. Billing / entitlement gate

Verify the accepted commercial lifecycle:
- trial activation after first working BP connection;
- Starter/Growth/Scale monthly/annual plans;
- BP/seat limits;
- voice allowance/top-ups;
- failed renewal/grace;
- upgrade/downgrade;
- cancel-at-period-end;
- inactive/read-only behavior;
- verified provider-event/reconciliation authority;
- no inbound loss because billing is blocked.

Core AI is customer-facing unmetered initially; voice is the first explicit metered resource.

## 12. Privacy / deletion gate

Test Contact/BP/Workspace deletion and correction/forget flows, including derived memory, summaries, embeddings/search, media derivatives/transcripts and caches under platform control.

Test export authorization/audit, removed-member access, sensitive-profile notification previews and secret redaction.

## 13. Media gate

Where supported, cover successful/failed/exhausted voice transcription, corrupt/unsupported/oversize attachment, vision/file-processing low confidence/failure and approved outbound media asset selection.

Customer attachment never silently becomes trusted Knowledge. Processing failure never permits invented media content.

## 14. Booking/external-action gate

Only if a capability is enabled for the release, test authoritative availability/provider state, idempotent writes, timeouts after external create, duplicate provider events and reconciliation. LLM proposes actions; application policy authorizes; adapter executes.

V1.1 Booking does not block the initial MVP if it remains disabled.

## 15. UX / localization / accessibility

MVP critical surfaces work in English and Russian with locale-aware dates/times/numbers/plural/currency formatting.

Verify mobile/responsive layouts, keyboard navigation, labels/focus, empty/loading/error/stale states and no misleading optimistic delivery success.

## 16. Observability / runbooks

Before launch, alerts/health visibility must cover at least:
- inbound/webhook failure;
- queue backlog/stuck work;
- AI/provider outage;
- channel credential/reconnect required;
- ambiguous-send spike;
- DB/Redis incident;
- billing webhook/reconciliation failure.

Each actionable alert has an operator runbook, not merely a metric.

## 17. Kill switches / feature flags

Required kill switches can stop automated outbound globally and by Workspace/BP/channel while preserving inbound ingestion by default.

High-risk/new capabilities use progressive feature flags and can be disabled without full deploy rollback.

## 18. Staged rollout

Release progression:
1. internal/test Workspaces;
2. limited design partners, DRAFT-first;
3. limited AUTOPILOT on explicitly selected BPs;
4. Commercial Beta;
5. broader availability.

New high-impact features repeat a staged rollout rather than inheriting global enablement automatically.

## 19. Per-customer go-live readiness

A technically released product does not make every BP AUTOPILOT-ready.

Per-BP checklist includes:
- channel connected/current;
- Knowledge sufficient/current;
- Style tested;
- objectives/qualification configured;
- timezone/language correct;
- Review/notification policy configured;
- Test Drive/golden scenarios acceptable;
- no unresolved operational blocker.

DRAFT is the initial safe default; AUTOPILOT requires explicit enablement.

## 20. Release evidence

Store/attach a compact release record:
- exact SHA;
- commands/checks and results;
- migrations;
- enabled feature flags;
- known limitations;
- rollback plan;
- reviewer status and exact reviewed SHAs;
- release actor/time.

## Commercial Beta exit criterion

A clean production-like deployment can connect supported Instagram/WhatsApp business channels, handle conversations through unified AI/policy/review/handoff safely, survive common dependency failures without silent data loss/double-send, enforce tenant/BP/billing/privacy boundaries, and be operated/recovered through documented health, kill switches and Admin Operations.