# Data Model — v0.3

## Workspace

Tenant boundary. Owns members, channel accounts, knowledge/style sources, policies and conversations.

## ChannelAccount

Conceptual fields: `id`, `workspace_id`, `channel (INSTAGRAM|WHATSAPP)`, `external_account_id`, `display_name`, `encrypted_credentials_ref`, `status`, `capabilities_json`, `default_ai_mode`, timestamps.

Instagram capability/config metadata may include whether Human Agent approval is known/verified, but current eligibility is evaluated from live/current policy state rather than assumed from a stale boolean alone.

## Contact / ContactIdentity

`Contact` is a canonical person/customer within a workspace. `ContactIdentity` links that person to a channel-specific identity with `contact_id`, `channel_account_id`, `external_user_id`, allowed display fields and metadata. Cross-channel linking may be explicit/verified later; never assume identities match only from similar names.

## Conversation

`workspace_id`, `contact_identity_id`, `channel_account_id`, `mode_override`, `ai_enabled`, `human_takeover_at`, `last_inbound_at`, `last_outbound_at`, `lead_stage`, `status`, timestamps.

## Message

`conversation_id`, `channel_message_id`, `direction (IN|OUT)`, `source (PARTICIPANT|AI|HUMAN|AUTOMATION|SYSTEM)`, `type`, text, media reference/metadata, timestamps and delivery/read state. Outbound metadata records whether the send used a normal transport path or an explicitly human-initiated approved Human Agent path.

## MessageTranscript

One reading of one recording on one message (P4-04): `message_id`, `provider_media_id`, `state
(PENDING|READY|FAILED|UNSUPPORTED)`, the words, and the provenance that says where they came from —
`provider`, `model`, `model_revision`, `language`, `duration_seconds`, `provider_request_id`, `latency_ms`,
`attempt_count`, `requested_at`, `completed_at` — plus `failure_reason`/`failure_code` and `media_deleted_at`.

Kept apart from the recording's reference on `messages` on purpose: the reading is a claim about the
recording with its own provenance and its own failure modes, and one message can carry several recordings.
`UNIQUE(workspace_id, message_id, provider_media_id)` is what makes a redelivered webhook — which the
provider sends for up to seven days — a no-op rather than a second reading of the same words.

CHECKs: a `READY` row has non-blank text with a provider and a model; nothing else carries text at all; a
`FAILED` or `UNSUPPORTED` row names its reason; a `confidence` exists if and only if a `confidence_source`
does, and only in 0..1; measurements move forward and cannot be negative; and `state = PENDING` if and only
if `completed_at` is null. The one that matters most is the second: a half-written reading reaching a
customer's reply as though the recording had been understood is the failure the table exists to prevent.

The foreign key to `messages` is `ON DELETE RESTRICT`, because a transcript is a record of what a customer
said and a deleted message would take it with it silently.

## AiDraft

`conversation_id`, `anchor_message_id`, `draft_text`, `structured_output_json`, `confidence`, `reason_codes`, `status`, model metadata and timestamps.

## DeliveryJobRecord

`draft_id`, `scheduled_for`, `selected_delay_ms`, claim/sent/cancel timestamps, status, attempt/correlation data and platform operation/reference fields.

## KnowledgeDocument / KnowledgeChunk

Trusted factual retrieval corpus with source/version/provenance and workspace/account scope.

## StyleExample

Inbound context plus verified human outbound example, scope and provenance (`HUMAN_TYPED|HUMAN_EDITED_DRAFT`). Never factual authority.

## AutomationPolicy

Account/workspace defaults and permitted overrides: mode, confidence threshold, review categories, timing ranges, quiet hours, takeover duration, channel policy options, and `instagram_after_window_policy` with values initially `STANDARD_ONLY | HUMAN_ASSISTED_EXTENDED`.

## Review/Handoff state

Review state should preserve why human action is needed. For Instagram Human Agent review, store the relevant window/eligibility snapshot and re-evaluate immediately before final human send rather than trusting the stored snapshot.

## Key constraints

- tenant/workspace scoping on every customer-owned table;
- unique source event per channel account;
- unique platform message IDs where stable;
- one completed outbound send per AI draft/action;
- human-agent sends require a human action/audit actor identity;
- foreign keys favor preserving audit history over destructive cascades.

## Implementation notes (P1-03, aligned with Data Model v0.4 / Issue #53)

This branch still carries the v0.3 text above; the Business Profile model it implements is `DATA_MODEL.md` v0.4 on `docs/phase6-commercial-billing`. The initial Prisma schema (`packages/db/prisma/schema.prisma`, migration `20260917140000_init`) makes the following decisions:

- **Tenancy chain.** A Workspace (tenant/billing) owns Business Profiles (`business_profiles`, status `SETUP | ACTIVE | INACTIVE`, never created implicitly).
  - Business Profile owned tables carry both `workspace_id` and `business_profile_id`: `channel_accounts`, `contacts`, `channel_identities`, `conversations`, `messages`, `ai_drafts`, `delivery_jobs`, `inbound_events`, `automation_policies`.
  - References between them are composite foreign keys that include both columns, so cross-Workspace and cross-Business-Profile references fail in the database. Tenant uniques lead with the same scope. `ON UPDATE RESTRICT` everywhere pins the scope of any row that other rows reference. A row without dependents could still be re-pointed by a raw update, so repositories never write scope columns on update.
- **Where vs what.** `workspace_members.business_profile_scope` is `ALL | SELECTED`; `member_business_profile_access` holds SELECTED grants, with composite FKs to member and profile in the same Workspace.
  - OWNER is always ALL (CHECK).
  - `authorizeBusinessProfileAccess` re-reads membership, role, scope and grants on every request. Unauthorized and nonexistent profiles fail identically.
  - Grants are removed with their membership (the only non-login cascade).
  - Provisional rules until team/billing tasks: OWNER or an ALL-scoped ADMIN creates profiles. An ADMIN's grants are bounded by its own scope, and only OWNER grants OWNER.
- **Delete behaviour.** History uses `ON DELETE RESTRICT`. Business Profiles are deactivated, not deleted.
- **Channels.** A channel account belongs to one Business Profile.
  - At most one live (not `DISCONNECTED`) account per profile and channel.
  - A platform account can be live in only one Workspace + profile, so webhooks route unambiguously.
  - `channel_credentials` stays Workspace-scoped (encrypted placeholder, 1:1 with its channel account). No plaintext tokens exist.
- **Identity.** `contact_identities` is renamed `channel_identities`. The identity is the stable provider user ID per channel account, `UNIQUE(workspace_id, business_profile_id, channel_account_id, external_user_id)`.
  - Contacts are canonical per Business Profile: the same provider user in two profiles is two contacts. There is no cross-profile identity graph.
  - `contact_points` / `ExternalIdentity` tables are deferred to identity-resolution work (the domain primitive exists).
- **Conversation.** Carries `business_profile_id`, `contact_id` (the identity's contact) and `channel_identity_id`.
  - One thread per identity per account.
  - Inbox index `(workspace_id, business_profile_id, status, last_message_at DESC)`.
  - `state_version` (non-negative, CHECK) increments atomically with each stored inbound message. Lead-stage changes do not increment it; later tasks add further triggers.
  - Takeover columns mirror the domain `HumanTakeoverState` (CHECK-enforced).
  - The takeover pause default of 6 h is unchanged and noted for P2-07.
- **Messages.**
  - Platform message IDs are unique per channel account.
  - `operation_id` is globally unique, and there is at most one message per AI draft.
  - CHECKs tie inbound rows to `PARTICIPANT` and require a human actor for `HUMAN_AGENT` sends.
- **AI drafts and delivery.** AI drafts carry `anchor_state_version` (CHECK >= 0). There is one delivery job per draft. A `SENT` job records `sent_at` and `platform_message_id`.
- **Automation policy.** One Business Profile default (partial unique) plus at most one channel-account override in the same profile. There is no Workspace-level policy row. `ChannelAccount.default_ai_mode` remains and is noted for consolidation by the Phase 2 policy engine.
- **Knowledge / style.**
  - `knowledge_documents` and `style_examples` have a nullable `business_profile_id` (NULL = Workspace base, set = profile override), replacing the old channel-account scope.
  - A style example learned from a message or draft must name its profile (CHECK), and its source FKs include the profile.
  - `knowledge_chunks` inherit scope through their document.
  - Vector and full-text columns come with retrieval (ADR-011).
- **Inbound events.** An `inbound_events` idempotency ledger, unique per (Workspace, Business Profile, channel account, source event).
- **Auth.js.** Users, provider-link-only accounts (no OAuth tokens), database sessions. No role or Business Profile scope is stored in the session.
- **CHECK constraints.** Constraints Prisma cannot express live in the migration SQL. `db:check-drift` confirms that migrations and schema are in sync.
