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
