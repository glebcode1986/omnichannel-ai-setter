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

## Implementation notes (P1-03)

The initial Prisma schema (`packages/db/prisma/schema.prisma`, migration `20260917140000_init`) implements this model with the following decisions and deviations:

- **Tenancy in the database.** Every customer-owned table has `workspace_id`. References between tenant tables are composite foreign keys that include `workspace_id` (for example `messages(workspace_id, channel_account_id, conversation_id) -> conversations`), so a row can never point at another workspace's data. Tenant unique keys lead with `workspace_id`. All foreign keys use `ON UPDATE RESTRICT`, so ownership cannot be moved.
- **Delete behaviour.** Everything uses `ON DELETE RESTRICT` except Auth.js `auth_accounts`/`auth_sessions`, which cascade from `users`. Records are archived rather than deleted.
- **Repositories.** Tenant repository functions require a `WorkspaceContext` issued by `authorizeWorkspaceAccess(userId, explicit workspaceId)`. Contexts that are forged or copied are rejected. Cross-workspace records are reported as not found.
- **`ChannelAccount.encrypted_credentials_ref`.** This is `credential_id`, pointing at `channel_credentials` (`key_id`, `algorithm`, `ciphertext`, `nonce`, `auth_tag`, `expires_at`). No plaintext token columns exist. Encryption and the Meta token lifecycle belong to the onboarding tasks.
- **ChannelAccount uniqueness.** A platform account (`channel`, `external_account_id`) can be live (not `DISCONNECTED`) in only one workspace, so webhooks route unambiguously.
- **Inbound events.** An added `inbound_events` table is the idempotency ledger, unique per (`workspace_id`, `channel_account_id`, `source_event_id`).
- **Conversation.** There is one conversation per contact identity per channel account, matching platform DM threads.
  - `human_takeover_at` is complemented by `takeover_state`, `takeover_reason`, `takeover_review_mode`, `takeover_paused_until`, `takeover_actor_kind` and `takeover_actor_user_id`, which mirror the domain `HumanTakeoverState`. A CHECK constraint keeps these fields consistent with the state.
  - `review_eligibility_snapshot` stores the Human Agent review snapshot.
  - Added `last_message_at` (not null) for inbox ordering.
- **Message.**
  - `type` is named `kind`.
  - Platform IDs are unique per channel account.
  - Adds `operation_id` (unique), `ai_draft_id` (at most one message per draft), `transport_path` and `sent_by_user_id`.
  - CHECK constraints tie inbound rows to `PARTICIPANT` and require a human actor for `HUMAN_AGENT` sends.
- **AiDraft.** Model metadata is stored as columns (`model_provider`, `model_name`, `prompt_version`, `schema_version`, `provider_request_id`, `latency_ms`). `confidence` must be in [0, 1].
- **DeliveryJobRecord** (table `delivery_jobs`). There is one job per draft, and `operation_id` is unique. A `SENT` job must have `sent_at` and `platform_message_id`. Together with the one-message-per-draft rule, this keeps one logical draft from becoming several sends.
- **Knowledge / style.** `knowledge_documents` carry source, version, status, content hash and an optional channel-account scope. `knowledge_chunks` are unique per document version and position and carry an `embedding_profile`. The pgvector and full-text columns and indexes are added by the retrieval task (ADR-011, RETRIEVAL.md). `style_examples` record provenance, and a `HUMAN_EDITED_DRAFT` example must reference its source draft.
- **AutomationPolicy.**
  - Timing ranges and quiet hours are stored as columns with the documented defaults.
  - Reason codes and the template allowlist are text arrays validated by the domain.
  - There is one workspace default (partial unique index) and at most one override per channel account.
- **Auth.js.** Tables are `users`, `auth_accounts`, `auth_sessions` and `auth_verification_tokens`, with database sessions. Linked accounts keep only the provider link: OAuth access, refresh and ID tokens are not persisted. No sign-in provider is enabled yet; that choice belongs to the app-shell task.
- **CHECK constraints.** Constraints Prisma cannot express live in the migration SQL. `db:check-drift` confirms that migrations and schema stay in sync.
