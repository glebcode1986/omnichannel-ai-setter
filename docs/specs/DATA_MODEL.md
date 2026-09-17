# Data Model — v0.4

**Status:** Consolidated product/domain model aligned with accepted Business Profile, Inbox/Review, customer memory, goals/follow-ups, booking, billing, integrations, media, lifecycle, API and identity contracts. This is a conceptual contract; implementation may split entities/tables as needed while preserving invariants.

## 1. Tenant hierarchy

### Workspace
Top-level tenant and billing boundary.

Conceptual fields:
- `id`
- `name`
- `default_locale`
- `default_timezone`
- lifecycle timestamps/state metadata
- created/updated timestamps

Workspace owns membership, subscription/entitlements, shared Knowledge/Style defaults, Business Profiles and workspace-level audit/security configuration.

### WorkspaceMember
Links a user account to a Workspace.

Fields include:
- `workspace_id`
- `user_id`
- role: `OWNER | ADMIN | AGENT`
- status
- invited/accepted/removed timestamps

Role answers **what** the member may do. Business Profile access answers **where**.

### MemberBusinessProfileAccess
Explicit BP scope where required.

Fields:
- `workspace_id`
- `workspace_member_id`
- `business_profile_id`
- optional narrowly scoped permission overrides

Unauthorized Business Profiles must be invisible across Inbox, search, analytics, notifications, leads and API results.

## 2. Business Profile

### BusinessProfile
Primary operational unit representing one business/brand/direction inside a Workspace.

Conceptual fields:
- `id`
- `workspace_id`
- `name`
- `status: SETUP | ACTIVE | INACTIVE`
- `timezone`
- customer/business language preferences
- `sensitive_mode` / privacy posture
- default AI mode
- objective/goal configuration reference
- notification-policy reference
- lifecycle/readiness metadata
- timestamps

A Business Profile owns its customer conversations, contacts, leads, channel accounts, policy overrides, booking configuration and BP-specific Knowledge/Style overrides.

Commercial packaging initially allows up to one Instagram account and one WhatsApp account per Business Profile. A second account of the same channel consumes another BP slot rather than silently expanding one BP.

`INACTIVE` preserves data; it is not deletion.

Operational readiness and billing entitlement are separate concepts. AUTOPILOT requires both sufficient entitlement and current operational readiness.

## 3. Channels and provider ingestion

### ChannelAccount
Belongs to one Business Profile.

Fields include:
- `id`
- `workspace_id`
- `business_profile_id`
- `channel: INSTAGRAM | WHATSAPP`
- `external_account_id`
- `display_name`
- encrypted credential reference (never plaintext secret)
- connection/status state
- `capabilities_json`
- provider metadata
- timestamps

Initial uniqueness: one active account per `(business_profile_id, channel)` unless a future product decision changes packaging.

Provider capabilities are stored as observations/configuration, but send eligibility is re-evaluated from current provider/policy state at execution time.

### ChannelEvent / WebhookReceipt
Durable normalized record of inbound provider events before/while application processing.

Fields include:
- `workspace_id`
- `business_profile_id`
- `channel_account_id`
- provider event/message identifiers
- event type
- received timestamp
- normalized payload reference / safe metadata
- processing state
- correlation ID

Provider/source event identity is unique when the provider supplies a stable key. Duplicate/reordered webhooks must not duplicate logical business effects.

## 4. Customer identity

### Contact
Canonical customer/person **within one Business Profile by default**.

Fields:
- `id`
- `workspace_id`
- `business_profile_id`
- display/preferred name
- customer language
- lifecycle/privacy metadata
- timestamps

There is no default cross-Business-Profile canonical customer graph. Sensitive BPs must not leak possible identity matches to unrelated BPs.

### ChannelIdentity
Links a Contact to a provider/channel identity.

Fields include:
- `contact_id`
- `channel_account_id`
- stable provider user/sender ID
- current display username/name
- provider metadata
- first/last seen timestamps

Stable provider IDs are preferred over mutable usernames.

### ContactPoint
Phone/email/etc.

Fields include:
- `contact_id`
- type
- original value
- conservative normalized value
- status: `VERIFIED | UNVERIFIED | SUPERSEDED | INVALID`
- source/provenance
- first seen / last confirmed timestamps

### ExternalIdentity
Links Contact to an external system identity.

Examples:
- CRM contact ID
- future prospecting-bot prospect ID
- imported customer-system identifier

Unique by `(source_system, external_id, business_profile_id)` where appropriate.

### ContactLink / MergeRecord
Records identity resolution decisions, evidence, actor/source, timestamps and reversible merge/split history.

Automatic merge is allowed only for strong deterministic evidence. Matching name/username/photo/message semantics must never auto-merge contacts. Phone/email matches across independent sources are duplicate candidates unless an explicit stronger policy exists.

## 5. Conversations and messages

### Conversation
One channel thread/context, attached to one Contact and Business Profile.

Fields include:
- `id`
- `workspace_id`
- `business_profile_id`
- `contact_id`
- `channel_identity_id`
- `channel_account_id`
- provider thread/reference where available
- `mode_override`
- `status`
- `state_version` / optimistic-concurrency anchor
- last inbound/outbound/activity timestamps
- close/waiting metadata
- timestamps

AI mode and human takeover are separate state dimensions.

### HumanHandoffState
Conceptually tracks:
- `NONE`
- `REVIEW_REQUIRED`
- `HUMAN_ACTIVE`

May be embedded in Conversation or represented by dedicated state/history tables. Human activity always wins over AI automation. Assignment is not takeover.

### Message
Fields include:
- `id`
- `workspace_id`
- `business_profile_id`
- `conversation_id`
- `channel_account_id`
- provider/channel message ID when stable
- direction: `IN | OUT`
- source: `PARTICIPANT | AI | HUMAN | AUTOMATION | SYSTEM`
- message type
- text/body reference
- reply/context metadata
- provider send/status metadata
- created/provider timestamps
- delivery/read state

Unique provider message IDs per channel account where stable.

Outbound metadata records whether a message was AI-generated, human-sent, approved from Review, or sent through a provider-specific human-assisted path.

### ConversationAttachment
Customer/chat media is conversation data, not trusted Business Knowledge.

Fields may include:
- message/conversation ID
- object-storage reference
- media type/MIME/size
- security-scan state
- transcription/vision/document-processing state
- derived transcript/analysis references
- retention metadata

`ConversationAttachment != KnowledgeDocument` even when both are PDFs/images.

## 6. AI decisions, drafts and actions

### AiDraft / AiDecision
Anchored to a specific conversation/message state.

Fields include:
- `conversation_id`
- `anchor_message_id`
- `anchor_state_version`
- draft text
- validated structured model output
- confidence
- `should_send` advisory
- `needs_review`
- reason codes
- intent
- proposed lead stage/action
- factual source IDs/provenance
- model/provider metadata
- status/timestamps

Model output is advisory. Application policy decides whether any customer-facing or external action may execute.

### ActionOperation
Normalized proposed/approved/executed side effect.

Fields include:
- `workspace_id`
- `business_profile_id`
- conversation/contact/lead references where applicable
- `action_type`
- risk class: `READ_ONLY | LOW_RISK_WRITE | REVIEW_REQUIRED | HUMAN_ONLY`
- proposed arguments
- anchor/version
- policy decision
- actor/source (`AI`, human member, API service account, automation)
- review/approval reference
- idempotency key
- correlation ID
- state: proposed/held/approved/executing/succeeded/failed/reconciliation-required/canceled/stale
- provider operation/reference metadata
- timestamps

Approvals bind to a concrete action and anchor. State changes before execution can invalidate an approval as stale.

## 7. Review

### ReviewItem
A Review item blocks a concrete action/conversation state, not the entire Business Profile.

Fields include:
- `workspace_id`
- `business_profile_id`
- `conversation_id`
- optional `action_operation_id`
- reason category/code
- priority
- anchor message/state version
- proposed draft/action
- supporting factual source/provenance references
- channel/window/provider-policy snapshot for operator context
- assignee
- status
- resolution actor/action/timestamps

Deduplicate logical Review items by conversation/reason/anchor where appropriate. New inbound/human activity may supersede older items.

Resolved items remain auditable.

## 8. Customer memory

### CustomerFact
Reusable verified/explicit customer information.

Fields include:
- `contact_id`
- BP-specific field/type
- value
- source type/reference (customer message, human confirmation, trusted import)
- `created_at`
- `last_confirmed_at`
- optional `valid_until`
- `status: ACTIVE | SUPERSEDED | EXPIRED`
- sensitivity classification

AI-generated text is never itself authoritative provenance for a customer fact.

### CustomerPreference
Explicit durable preference (e.g. contact time/channel). Same provenance/freshness rules as CustomerFact.

Do not store speculative psychological traits, inferred wealth/vulnerability or manipulation-oriented profiling as durable reusable memory.

### ConversationSummary
Assistive concise history only. It is not a truth source and is superseded by current direct customer messages and verified facts.

### EphemeralCustomerContext
Short-lived context such as "travelling today" or "write in one hour" with expiry/TTL. Not a permanent trait.

## 9. Knowledge and Style

### KnowledgeDocument / KnowledgeVersion / KnowledgeChunk
Trusted factual business corpus.

Scope can be:
- Workspace base/default;
- Business Profile override/specific source.

Fields include source/provenance, version, active state, `valid_until`, `review_after`, ingestion/index state and timestamps.

Superseded/expired/deleted versions must not remain retrievable through stale embeddings/search indexes.

### StyleProfile
Workspace base + optional BP override for communication persona/dimensions. Style never changes factual authority or deterministic policy.

### StyleExample
Verified human outbound examples with context/provenance (`HUMAN_TYPED | HUMAN_EDITED_DRAFT`). Style examples are phrasing evidence, never business facts.

## 10. Leads and qualification

### Lead
Commercial/target opportunity linked to Contact, not synonymous with Contact or Conversation.

Fields include:
- `workspace_id`
- `business_profile_id`
- `contact_id`
- primary/source conversation
- stage: `NEW | ENGAGED | QUALIFYING | QUALIFIED | NEXT_STEP | BOOKED | WON | LOST` (BP may label/configure presentation)
- interest/service
- structured qualification values
- assignee
- source attribution
- stage reason
- timestamps

One Contact may have multiple Leads/opportunities over time.

### LeadStageHistory
Append-oriented stage transitions with actor/source, reason and timestamps.

### QualificationFieldDefinition / LeadQualificationValue
Business-Profile-scoped configurable qualification schema and values.

Terminal-stage automation is policy controlled and may require human confirmation.

## 11. Goals, next actions, follow-ups and human tasks

### ConversationGoal
Primary/secondary goal configuration/instance linked to BP/conversation/lead as appropriate.

### NextAction
At most one primary active next action per conversation/goal context.

Examples include `WAIT_FOR_CUSTOMER`, `ASK_QUALIFICATION_QUESTION`, `OFFER_BOOKING`, `SEND_REQUESTED_INFO`, `FOLLOW_UP_LATER`, `HANDOFF_TO_HUMAN`, `HUMAN_CALL_CUSTOMER`, `NO_FURTHER_ACTION`.

### FollowUp
Durable scheduled automation with:
- reason/goal
- due time/local-time policy
- attempt count
- anchor/context version
- status
- cancellation/supersession reason

Every execution revalidates conversation anchor, takeover/review, opt-out, goal relevance, channel eligibility, entitlement and deduplication.

### HumanTask
Internal task/reminder with due date, assignee, BP/conversation/lead context and completion/dismissal state. Completing/dismissing a task does not send a customer message.

## 12. Booking / appointments

### BookingConfiguration / AppointmentType
Business-Profile-scoped booking configuration: provider/calendar/resource mappings, duration, buffers, notice/horizon, hours, staff/resources, location/mode, cancellation/reschedule rules, confirmation mode and deposit metadata.

### Appointment
Normalized internal booking record.

States include:
- `AVAILABLE`/proposal is not persisted as confirmed appointment unless needed;
- `HELD`
- `CONFIRMED`
- `CANCELED`
- `RESCHEDULED`
- `FAILED`
- `RECONCILIATION_REQUIRED`

Fields include BP/contact/lead/conversation, appointment type, timezone-aware start/end, staff/resource/location, provider reference, correlation/idempotency identifiers, payment/deposit state and timestamps.

Provider availability is authoritative; displayed availability is not a reservation unless an actual hold exists.

### BookingOperation
Create/reschedule/cancel provider-side operation with normalized ambiguity/reconciliation state. Never blind-retry an unknown external write outcome.

### AppointmentReminder
Implemented as follow-up automation and invalidated when the appointment changes/cancels.

## 13. Integrations and developer access

### IntegrationConnection
Business-Profile or Workspace scoped external connector.

Fields include:
- provider/type
- scope
- encrypted credential reference
- declared capabilities
- connection health/status
- source-of-truth mapping configuration
- timestamps

Provider credentials never enter LLM prompts, ordinary logs or plaintext audit.

### ApiServiceAccount / ApiCredential
Dedicated system-to-system actor with Workspace/BP scopes, permissions/scopes, key fingerprint, status, last-used and rotate/revoke metadata. Secret material is stored separately and shown only at creation.

### WebhookEndpoint / WebhookDelivery
Configured outbound webhook endpoint, signing-secret reference, subscribed event types, delivery attempts and durable at-least-once delivery/replay state.

### ExternalIdentity / Attribution
See customer identity section. Acquisition source/campaign/prospect attribution persists through funnel analytics when available.

## 14. Media Library

### MediaAsset
Approved Business Profile asset that may be sent according to policy.

Fields include:
- `workspace_id`
- `business_profile_id`
- object reference
- type/name/tags
- approval state
- send policy (`AUTO_ALLOWED`, `REVIEW_REQUIRED`, `INTERNAL_ONLY` or equivalent)
- version/retention metadata

AI selects an approved asset ID; it must not invent arbitrary outbound URLs/assets.

## 15. Automation policy

### AutomationPolicy
Primarily Business-Profile scoped with optional channel-specific overrides.

Contains:
- mode defaults
- confidence/review posture
- timing/debounce/delayed-send ranges
- quiet hours/dayparts
- takeover/resume policy
- follow-up limits
- channel after-window/template policy
- action approval matrix references
- booking mode
- discount/payment/refund/action thresholds

Policy configuration does not replace live execution-time revalidation.

## 16. Delivery and outbound coordination

### DeliveryOperation / DeliveryJobRecord
Durable customer-facing send operation.

Fields include:
- originating draft/action
- conversation/message references
- scheduled time and selected delay
- claim/lease metadata
- idempotency/correlation identifiers
- provider request/reference identifiers
- state including ambiguous/reconciliation-required
- sent/cancel/failure timestamps

One logical approved outbound action must not produce duplicate sends. Unknown provider outcome is quarantined for reconciliation, never blind retried.

Queue systems are execution mechanisms, not the sole source of durable intent/state.

## 17. Notifications

### NotificationPreference
Member + BP/event-class/channel preferences, quiet hours and digest configuration. Notification preferences never grant authorization.

### NotificationEvent / Delivery
Deduplicated operational notifications by severity (`CRITICAL`, `ACTION_NEEDED`, `INFORMATIONAL`) with delivery-channel status. Routine AUTOPILOT replies do not generate per-message notifications.

## 18. Billing, entitlements and usage

### WorkspaceSubscription
Workspace billing state normalized from provider events:
`TRIALING | ACTIVE | PAST_DUE | GRACE | CANCELED_PENDING_END | INACTIVE`.

Billing state is not Business Profile/channel readiness state.

### PlanVersion / EntitlementSnapshot
Immutable/versioned plan meaning plus authoritative resolved Workspace entitlement snapshot.

### BillingOrder / ProviderBillingReference
Pre-created/normalized provider transaction references, reconciliation and lifecycle state. Success redirects are never authoritative payment proof.

### UsageCycle / UsageLedgerEntry
Idempotent usage accounting. Public metered resource includes voice transcription seconds/minutes; AI-generation telemetry may remain internal rather than a public quota.

### AddOn / TopUp entitlement records
Represent purchased BP/seat capacity and one-time voice packages with explicit validity rules.

Downgrade/cancel never silently deletes customer data.

## 19. Lifecycle, deletion and retention

### DeletionJob
Durable workflow:
`REQUESTED -> PROCESSING -> COMPLETED | PARTIAL_FAILURE`.

Tracks scope (Contact/BP/Workspace), derived-data cleanup, external-system limitations, actor and timestamps.

Deletion must reconcile derived summaries, memory, embeddings/search indexes, media derivatives/transcripts and caches where under platform control.

### RetentionPolicy
Workspace/BP policy references for conversation/media/sensitive-data retention. Analytics retention is separate from conversation-history retention.

Deactivate != delete.

## 20. Audit

### AuditEvent
Append-oriented record of material customer-owned actions/configuration changes.

Fields include:
- `workspace_id`
- optional `business_profile_id`
- actor type/id (member, AI/system policy, API service account, provider where appropriate)
- action/event type
- target type/id
- correlation ID
- safe structured metadata
- timestamp

Audit must not copy secrets or unnecessary sensitive conversation content.

### PlatformSecurityAuditEvent
Separate internal-platform audit for support/admin access, break-glass sessions, entitlement overrides, platform kill switches and internal operator actions. Customer Workspace membership does not grant platform-admin access and vice versa.

## 21. Support/Admin operational state

### SupportAccessSession
Time-bounded, scoped internal support-access record with reason/ticket reference, approved scope, actor, start/end and break-glass indicator where applicable.

### OperationalOverride
Typed, auditable, expiring platform override such as temporary entitlement extension. Avoid arbitrary production JSON/DB edits as routine support behavior.

## 22. Search and derived indexes
Search indexes, embeddings, cached summaries and analytics aggregates are derived data. Authoritative relational/domain state remains source of truth. Authorization is applied before search-result exposure. Semantic similarity must never be identity evidence.

## 23. Cross-cutting constraints

- Every customer-owned row is tenant-scoped. BP-owned rows should carry both `workspace_id` and `business_profile_id` (even when derivable) where useful for explicit authorization and composite FK protection.
- Prefer composite keys/FKs that prevent attaching a BP-owned record to a Contact/Conversation from another Workspace/BP.
- No automatic cross-BP Contact merge.
- Unique provider/source events and provider message IDs where stable.
- Idempotency keys are scoped to actor/integration/operation domain to prevent duplicate logical effects.
- Human activity overrides AI automation.
- Assignment is not takeover.
- Review approval is bound to a concrete anchor/version and can become stale.
- External side effects revalidate authorization, policy, entitlement, current state and provider eligibility immediately before execution.
- Unknown external-write outcome becomes `RECONCILIATION_REQUIRED`; no blind retry.
- Queue/Redis state is never the only durable record of a customer-impacting operation.
- Secrets are referenced securely, never stored in plaintext product rows/logs/prompts/audit.
- Foreign keys/retention favor preserving required audit/history while respecting deletion/privacy workflows.

## 24. Migration direction from v0.3

The old v0.3 model was Workspace-centric and placed ChannelAccount/Contact/Conversation directly under Workspace. Implementation must migrate toward Business Profile as the operational/customer-data scope before persistence becomes broadly depended upon.

Key changes:
1. introduce `BusinessProfile`;
2. add `business_profile_id` to ChannelAccount, Contact, Conversation and all BP-owned operational entities;
3. scope Contact canonically to Business Profile, not whole Workspace;
4. add explicit member-to-BP access model;
5. separate customer identity, reusable memory, Review, Lead, Goal/Follow-up, Booking, Integration, Media, ActionOperation and lifecycle/billing state;
6. preserve existing provider-event/message idempotency and AI/human delivery invariants.

No implementation should introduce a new Workspace-global Contact merge or direct external-system database access as a shortcut while this migration is underway.