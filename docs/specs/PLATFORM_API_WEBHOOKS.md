# Platform API / Webhooks / Developer Integration Contract

**Status:** Product/architecture contract prepared for later implementation.

## Purpose

Provide a stable integration boundary for external CRMs, Google Sheets/automation tools, Make/n8n/Zapier, custom customer systems, and the future outbound acquisition/prospecting bot without exposing internal persistence or bypassing product policy.

## Core principles

1. External systems call application-level business operations, never database-shaped CRUD endpoints.
2. Public API contracts are versioned from day one (`/api/v1`).
3. System-to-system access uses scoped service credentials/API keys, not user dashboard cookies.
4. Business Profile scope is explicit; a key scoped to one BP cannot access another.
5. API access never bypasses RBAC, entitlement, channel capability, review, takeover, booking, delivery, or payment policy.
6. Any side-effecting write must support idempotency.
7. Long-running operations return an operation identifier and complete asynchronously.
8. Outbound webhooks use at-least-once delivery; consumers must deduplicate by `event_id`.
9. Webhook delivery ordering is not globally guaranteed; aggregate version/sequence metadata should be included when relevant.
10. Every external write is auditable with service-account identity, key fingerprint, correlation ID, target BP, and resulting action.

## Authentication and scopes

API keys/service accounts are created by authorized workspace users and are shown only once at creation. Stored secrets are never exposed again; UI shows fingerprint/last-used metadata and supports rotate/revoke.

Representative scopes:

- `contacts:read`
- `contacts:write`
- `leads:read`
- `leads:write`
- `conversations:read`
- `conversation_content:read` (separate sensitive scope)
- `tasks:write`
- `bookings:read`
- `bookings:write`
- `attribution:write`
- `webhooks:manage`

Scopes authorize entry to application use cases only; they do not override domain/policy decisions.

## Future prospecting-bot handoff

The outbound acquisition system is upstream of the omnichannel setter. It may send engagement/handoff context such as:

- external `prospect_id`;
- `campaign_id`;
- source system/channel;
- normalized contact points;
- personalized opener/offer summary;
- CTA type and engagement event;
- language and safe personalization context;
- acquisition timestamp and attribution metadata.

It must **not** create fake Instagram/WhatsApp conversation messages. Real channel conversations are grounded in actual provider webhook events. The application matches a genuine inbound identity/event to prior prospect attribution, then links/creates the Contact and continues the normal AI Setter flow.

Recommended domain event: `PROSPECT_ENGAGED` / `prospect.engaged`.

The main product sends normalized outcome webhooks back upstream, including:

- `lead.created`
- `lead.qualified`
- `lead.stage_changed`
- `booking.confirmed`
- `lead.won`
- `lead.lost`
- `contact.opted_out`

This enables attribution from cold prospect -> engagement -> qualification -> booking -> sale.

## Idempotency and operation identity

Side-effecting endpoints accept `Idempotency-Key`. Repeating the same logical request with the same key returns the original logical result rather than duplicating work.

All material operations have stable `operation_id` / `correlation_id` values usable across API requests, jobs, provider calls, audit, Admin Operations and webhook deliveries.

Conflicting reuse of an idempotency key with different request semantics must fail with a stable error such as `IDEMPOTENCY_CONFLICT`.

## Asynchronous operations

Long-running or provider-dependent actions return `202 Accepted` plus `operation_id` when appropriate.

Normalized operation states:

- `PENDING`
- `SUCCEEDED`
- `REVIEW_REQUIRED`
- `FAILED`
- `RECONCILIATION_REQUIRED`
- `CANCELED`

Clients may poll `/operations/{id}` or subscribe to result webhooks.

## Outbound webhooks

Representative event families:

- `lead.created`
- `lead.qualified`
- `lead.stage_changed`
- `booking.confirmed`
- `booking.cancelled`
- `review.created`
- `conversation.human_requested`
- `contact.opted_out`
- `prospect.engaged`

Envelope fields should include:

- `event_id`
- `type`
- `occurred_at`
- `workspace_id`
- `business_profile_id`
- `aggregate_id`
- aggregate version/sequence where relevant
- versioned `data`

Webhook semantics are at-least-once. A receiver must deduplicate by `event_id` and tolerate retries and out-of-order delivery.

## Webhook authenticity

Outbound webhook payloads are signed (for example HMAC over timestamp + raw payload). Receivers verify signature and timestamp freshness before processing. Secret rotation should support a short overlap period where both old and new secrets validate.

## Retry and delivery inspection

Non-2xx webhook responses use bounded exponential backoff. After the retry budget is exhausted the delivery becomes `DELIVERY_FAILED` and is visible in Settings/Developers and Admin Operations.

The delivery UI should expose event type, event id, endpoint, attempt count, latest HTTP status and timestamps without exposing secrets.

Manual replay re-sends the same logical event/event_id, preserving receiver-side deduplication semantics.

A `Send test webhook` action is required.

## Message sending through API

If a public API message-send action is ever exposed, it **must** use the same Delivery Coordinator / policy path as dashboard and AI-generated messages. The API cannot send directly to Meta/provider infrastructure.

Before a send, the application revalidates channel window/capability, effective AI/human state, takeover, entitlement, deduplication, provider policy and any Review blocker.

## Pagination and filters

List APIs use cursor pagination. Filters may include BP, stage/status, channel, assignee and `updated_after`. Authorization is applied before search/result exposure.

## Rate limits

Apply separate rate limits for inexpensive reads, writes, expensive search and AI-triggering actions. `429` responses include stable retry metadata. Rate limiting never substitutes for authorization.

## Sensitive data

API responses follow least privilege. `leads:read` does not imply unrestricted conversation content. Sensitive Business Profiles may require separate `conversation_content:read` and export permissions.

Secrets, provider tokens and internal credentials are never returned through the public API.

## Opt-out / suppression synchronization

A confirmed customer opt-out in the main product emits `contact.opted_out` so upstream acquisition systems suppress future outreach to that identity for the applicable purpose/channel.

Where appropriate, authoritative suppression state from acquisition systems may be imported into the main platform through an explicit normalized endpoint; external tools must not write arbitrary suppression rows directly to storage.

## Attribution

Attribution is first-class and persists through the funnel. Suggested fields include source system, source type, campaign id, prospect id, original channel and acquisition/engagement timestamps.

Analytics may then connect acquisition source to engaged, qualified, booked and won/lost outcomes.

## Source of truth

Google Sheets, Make, n8n, Zapier and external CRMs are integration endpoints, not hidden authoritative databases unless a future integration explicitly declares a field/domain as externally authoritative.

Deleting or editing a row in a connected sheet must not implicitly delete internal contacts/leads.

## Developer UX

A future Settings -> Developers area should include:

- API keys/service accounts;
- scopes and BP access;
- webhook endpoints and secrets;
- event delivery logs/replay;
- connection tests;
- generated API documentation.

OpenAPI/schema documentation should be generated from machine-readable contracts rather than maintained separately by hand.

## Stable error codes

Representative machine-readable error codes:

- `INSUFFICIENT_SCOPE`
- `BUSINESS_PROFILE_NOT_FOUND`
- `ACTION_REQUIRES_REVIEW`
- `CHANNEL_NOT_ELIGIBLE`
- `STALE_OPERATION`
- `IDEMPOTENCY_CONFLICT`
- `RATE_LIMITED`
- `ENTITLEMENT_REQUIRED`
- `OPERATION_RECONCILIATION_REQUIRED`

Human-readable text may evolve; error codes are the stable integration contract.

## Audit

Every external write records actor/service account, key fingerprint, workspace/BP scope, operation, timestamp and correlation ID. External integrations are first-class actors, not anonymous `SYSTEM` changes.

## Architecture invariant

```text
External System
  -> authenticated/scoped API
  -> Application Use Case
  -> Authorization / Policy / Entitlement / State Revalidation
  -> Domain
  -> Infrastructure / Provider

Domain Event
  -> transactional/outbox publication
  -> signed webhook delivery
  -> External System
```

Forbidden shortcuts include direct external database access, fake provider messages, direct-to-provider message sends outside the Delivery Coordinator, and integration-specific bypasses around Review/human takeover/billing/channel policy.
