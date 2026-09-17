# MVP / V1 / Later Feature Phasing

**Status:** Product scope contract for implementation sequencing and commercial launch.

## Goal

Ship a sellable, safe omnichannel AI setter/support product without forcing every designed future capability into the first commercial release. Architecture should preserve later extension points, but implementation priority follows customer value, operational safety, and launch readiness.

## Product principle

Design broadly, implement narrowly.

A feature may be architecturally modeled now without being implemented in MVP. "Not in MVP" does not mean "forbidden forever"; it means the first sellable release must not depend on it.

## MVP — required before first normal paid customer

### Core SaaS / tenancy
- Workspace + Business Profile hierarchy.
- Roles: OWNER / ADMIN / AGENT with Business Profile scope.
- Server-side authorization on every customer-owned query/action.
- Basic onboarding and resumable setup.
- English + Russian production-grade UI foundation.

### Channels
- Instagram official messaging integration.
- WhatsApp Cloud API first-class integration.
- Durable provider webhook ingestion, deduplication and reordered-event tolerance.
- Channel capability/eligibility state.
- No browser automation in production transport.

### Unified Inbox
- Cross-channel conversation list.
- Conversation thread + composer.
- Contact/lead side panel.
- Effective AI mode visible.
- Human takeover / Resume AI.
- Pending delayed-send state + cancel.
- Search by allowed customer/message identifiers within authorized BP scope.
- Responsive/mobile-essential flow.

### AI behavior
- OFF / DRAFT / AUTOPILOT.
- Debounce before generation.
- Durable post-draft delay.
- Structured model output validated at the application boundary.
- Deterministic send policy; model `should_send` is advisory only.
- Stale-draft/anchor protection.
- Human always wins over AI automation.
- AI continues server-side with browser closed.

### Knowledge + Style
- Trusted Knowledge sources with provenance/version/freshness.
- Missing-fact Review path rather than hallucinated business truth.
- Workspace base + Business Profile override.
- Style profile and approved examples.
- Style cannot override factual authority or send policy.
- Basic Test Knowledge / Test Style / Test Drive experience.

### Review Queue
- First-class Review queue linked to the same conversation context.
- Core reasons: missing fact, low confidence, human requested, complaint/sensitive case, media/technical failure, channel policy, ambiguous delivery.
- Send / Edit & Send / Dismiss / Take over / Resume AI.
- Stale Review protection.
- No bulk customer-facing AI approval.

### Leads
- Contact separate from Lead.
- Basic pipeline: NEW / ENGAGED / QUALIFYING / QUALIFIED / NEXT_STEP or BOOKED / WON / LOST.
- BP-specific qualification fields.
- AI may propose stage changes under policy.
- Inbox lead card and simple list/kanban/table experience.

### Goals / follow-ups
- Primary conversation goal / next action concept.
- Basic scheduled follow-up with conservative limits.
- Revalidation before every follow-up send.
- Cancel/supersede on new customer reply, human activity, opt-out, stale context or invalid channel state.
- Human task/reminder separate from automated follow-up.

### Customer identity / memory
- Contact scoped to Business Profile by default.
- Channel identities and contact points.
- No automatic weak-evidence merge.
- Basic verified customer facts/preferences with provenance/freshness.
- Conversation summary assistive only, not truth source.

### Media
- Receive/display common channel media.
- Voice transcription with allowance accounting.
- Image/file processing only when supported and reliable.
- Processing failure never causes invented content.
- ConversationAttachment separate from KnowledgeDocument.
- Basic approved outbound Business Media assets may be sent by policy.

### Reliability / delivery
- Durable inbound persistence.
- Durable outbound/send operation state.
- No blind retry after ambiguous provider outcome.
- Reconciliation state for unknown external writes.
- Queue state is not the sole durable source of intent.
- Safe degradation when AI, Redis or one channel dependency fails.
- Basic health UI and operator alerts.

### Billing / packaging
- Starter / Growth / Scale catalog and accepted plan capacities.
- 14-day trial beginning after first successful working Business Profile/channel connection.
- Subscription lifecycle: TRIALING / ACTIVE / PAST_DUE / GRACE / CANCELED_PENDING_END / INACTIVE.
- BP and seat entitlements.
- Voice transcription allowance + manual top-ups; no automatic overage.
- Inbound messages are not dropped due to subscription/quota state.
- Provider-neutral billing boundary with one production provider selected before paid launch.

### Admin Operations — minimum commercial set
- Workspace lookup.
- Subscription/entitlement inspection.
- Channel health/connection diagnostics.
- Reconciliation queue for ambiguous operations.
- Scoped/time-limited support access model.
- Global/Workspace/BP/channel outbound kill switches.
- Internal platform audit for support/administrative access.

### Security / privacy minimum
- Strong tenant/BP isolation.
- Encrypted secret references, no secrets in prompts/logs/audit.
- Immediate access revocation on member removal.
- Basic export/deletion flows.
- Deletion includes derived memory/search/index/media derivatives where under platform control.
- Critical internal/support access audited.

### Launch gates
- CI/verification on exact release SHA.
- End-to-end channel tests.
- Human-vs-AI race-condition tests.
- Tenant isolation tests.
- Payment/subscription transition tests.
- Ambiguous-send/reconciliation tests.
- AUTOPILOT test with dashboard/browser closed.
- Kill-switch verification.
- Staged rollout: internal -> design partners -> limited AUTOPILOT -> broader availability.

## V1.1 / Near-term after MVP

These are high-value extensions that should follow soon after core commercial stability, but do not block first paid launch.

### Booking / appointments
- Provider-neutral calendar/booking port.
- Appointment types, staff/resources, availability, booking/reschedule/cancel.
- `SUGGEST_ONLY`, `REVIEW_BEFORE_BOOK`, `AUTONOMOUS_BOOKING` modes.
- Reminder automation.
- Booking reconciliation.
- Basic deposit/payment-state integration where required.

### CRM/data integrations
- At least one practical CRM or Google Sheets/export workflow.
- Explicit source-of-truth mapping.
- Action Gateway for side effects.
- Safe integration failure isolation.

### Public API / outbound webhooks
- `/api/v1` foundation.
- Scoped service accounts/API keys.
- Idempotency keys.
- Signed at-least-once outbound webhooks.
- Lead/booking/opt-out events.
- Initial handoff boundary for the future prospecting/acquisition bot.

### Better identity/dedup UX
- Possible-duplicate suggestions.
- Manual merge/split with audit.
- External identity linking.
- Stronger cross-channel continuity inside one BP.

### Advanced operational tooling
- Better queue/job inspector.
- Provider health timelines.
- Support snapshot generation.
- Feature flags for progressive rollout.

### Analytics improvements
- Goal-aware conversion analytics.
- AUTOPILOT health/quality metrics.
- Missing-fact/edit/takeover/review diagnostics.
- Acquisition/source attribution when upstream data exists.

## V1.5 / Growth phase

### Expanded integrations
- Multiple calendar providers.
- CRM adapters.
- Make / n8n / Zapier-friendly developer surface.
- Custom webhooks / API extensions.

### Advanced booking/payments
- More vertical booking providers.
- Deposits and payment-link workflows.
- More complex cancellation/reschedule rules.

### Richer media automation
- More document understanding.
- Better catalog/media selection.
- Optional AI-generated media behind explicit review/policy.
- AI voice replies only after separate product/safety/cost decision.

### Team operations
- More granular permission toggles.
- Assigned-only sensitive conversations.
- Advanced workload/assignment routing.

### Lifecycle / retention controls
- Configurable conversation/media retention by Workspace/BP.
- Stronger privacy controls for sensitive business profiles.
- More automated reactivation/readiness checks.

## Later / intentionally not MVP

### Outbound acquisition / prospecting product
The cold-base discovery, enrichment, campaign personalization and outbound prospecting bot is a separate product/domain. The current system only preserves the integration/handoff boundary and attribution model.

### Broad cold outbound campaign engine
No mass cold-messaging engine inside the current MVP.

### Telegram as first-class conversation channel
Architecturally possible later; not required for MVP.

### Instagram Threads private messaging
Future only if official supported messaging capabilities are available and product/legal/channel review approves.

### Universal CRM
The product is not intended to replace every CRM function. It owns conversation-centered customer context, leads, goals and next actions; deep sales operations may remain in integrated CRMs.

### Fully autonomous high-impact actions
Refunds, workspace deletion, ownership/security changes, unrestricted discounts and other high-impact actions remain human-controlled unless a future explicit product decision changes a specific class.

### Automatic cross-Business-Profile identity graph
Not default. BP remains the privacy/operational identity boundary.

### Silent self-learning that mutates Knowledge or Style
Not allowed. Suggestions may be generated, but trusted business facts and material style changes remain explicitly approved.

## Scope guardrails for Claude / implementation agents

1. Do not implement a Later feature merely because the conceptual Data Model contains an extension point for it.
2. Prefer interfaces/ports and stable IDs over speculative full provider implementations.
3. MVP code must preserve future compatibility without adding unused distributed-system complexity.
4. Every new work package should state whether it is MVP, Near-term, Growth, or Later.
5. If a task expands scope beyond its phase, stop at the contract boundary and leave a documented extension point.
6. Safety-critical foundations (tenant isolation, human takeover, stale-action protection, idempotency, reconciliation, audit) are not optional MVP cuts.
7. Do not delay launch for cosmetic completeness when the user can safely achieve the core value without it.

## MVP commercial promise

A paying customer should be able to connect Instagram and/or WhatsApp, configure trusted business knowledge and communication style, let AI handle normal conversations in DRAFT or AUTOPILOT, see all conversations in one Inbox, take over at any time, review exceptional cases, qualify leads, schedule safe follow-ups, and understand when the system needs human attention.

The product must keep working server-side with the dashboard closed, preserve inbound traffic during partial failures, and fail safely rather than inventing facts or duplicating risky external actions.

## Non-goal of MVP

MVP is not "every feature described in the architecture." It is the smallest commercially credible implementation of the product's core promise with the safety/operational foundations required for real customer traffic.
