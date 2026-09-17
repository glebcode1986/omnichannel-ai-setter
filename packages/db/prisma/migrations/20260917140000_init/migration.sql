-- CreateEnum
CREATE TYPE "ChannelType" AS ENUM ('INSTAGRAM', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "AiMode" AS ENUM ('OFF', 'DRAFT', 'AUTOPILOT');

-- CreateEnum
CREATE TYPE "WorkspaceRole" AS ENUM ('OWNER', 'ADMIN', 'AGENT');

-- CreateEnum
CREATE TYPE "BusinessProfileAccessScope" AS ENUM ('ALL', 'SELECTED');

-- CreateEnum
CREATE TYPE "BusinessProfileStatus" AS ENUM ('SETUP', 'ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "ChannelAccountStatus" AS ENUM ('CONNECTED', 'NEEDS_REAUTH', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('OPEN', 'CLOSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "LeadStage" AS ENUM ('NEW', 'ENGAGED', 'QUALIFYING', 'QUALIFIED', 'BOOKED', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "TakeoverState" AS ENUM ('NONE', 'REVIEW_REQUIRED', 'HUMAN_ACTIVE');

-- CreateEnum
CREATE TYPE "TakeoverReason" AS ENUM ('HUMAN_SENT_FROM_INBOX', 'UNMATCHED_OUTBOUND_ECHO', 'HUMAN_CLAIMED', 'MANDATORY_REVIEW', 'LOW_CONFIDENCE_REVIEW', 'DRAFT_MODE_REVIEW', 'HUMAN_AGENT_REVIEW', 'AMBIGUOUS_DELIVERY');

-- CreateEnum
CREATE TYPE "ReviewMode" AS ENUM ('NORMAL', 'HUMAN_AGENT');

-- CreateEnum
CREATE TYPE "ActorKind" AS ENUM ('USER', 'NATIVE_APP', 'SYSTEM');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "MessageSource" AS ENUM ('PARTICIPANT', 'AI', 'HUMAN', 'AUTOMATION', 'SYSTEM');

-- CreateEnum
CREATE TYPE "MessageKind" AS ENUM ('TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT', 'INTERACTIVE', 'TEMPLATE', 'REACTION', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "MessageDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED');

-- CreateEnum
CREATE TYPE "OutboundTransportPath" AS ENUM ('STANDARD', 'HUMAN_AGENT');

-- CreateEnum
CREATE TYPE "ChannelEventType" AS ENUM ('INBOUND_MESSAGE', 'OUTBOUND_ECHO', 'DELIVERY_STATUS', 'READ_STATUS', 'REACTION', 'POSTBACK', 'CONVERSATION_POLICY');

-- CreateEnum
CREATE TYPE "AiDraftStatus" AS ENUM ('PENDING', 'HELD', 'SCHEDULED', 'CLAIMED', 'SENT', 'FAILED', 'HELD_AMBIGUOUS', 'CANCELLED_SUPERSEDED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "DeliveryJobStatus" AS ENUM ('SCHEDULED', 'SENDING', 'SENT', 'CANCELLED_SUPERSEDED', 'CANCELLED_HUMAN_TAKEOVER', 'CANCELLED_POLICY', 'HELD_REVIEW', 'HELD_AMBIGUOUS', 'FAILED_RETRYABLE_EXHAUSTED');

-- CreateEnum
CREATE TYPE "KnowledgeSourceType" AS ENUM ('MANUAL', 'FILE', 'URL');

-- CreateEnum
CREATE TYPE "KnowledgeDocumentStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "StyleExampleProvenance" AS ENUM ('HUMAN_TYPED', 'HUMAN_EDITED_DRAFT');

-- CreateEnum
CREATE TYPE "StyleExampleStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "InstagramAfterWindowPolicy" AS ENUM ('STANDARD_ONLY', 'HUMAN_ASSISTED_EXTENDED');

-- CreateEnum
CREATE TYPE "WhatsAppAfterWindowPolicy" AS ENUM ('SERVICE_WINDOW_ONLY', 'TEMPLATE_REVIEW', 'TEMPLATE_AUTOPILOT');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "email_verified" TIMESTAMP(3),
    "image" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_accounts" (
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_account_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_accounts_pkey" PRIMARY KEY ("provider","provider_account_id")
);

-- CreateTable
CREATE TABLE "auth_sessions" (
    "session_token" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("session_token")
);

-- CreateTable
CREATE TABLE "auth_verification_tokens" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_verification_tokens_pkey" PRIMARY KEY ("identifier","token")
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_members" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "WorkspaceRole" NOT NULL,
    "business_profile_scope" "BusinessProfileAccessScope" NOT NULL DEFAULT 'SELECTED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_profiles" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "BusinessProfileStatus" NOT NULL DEFAULT 'SETUP',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_business_profile_access" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "workspace_member_id" TEXT NOT NULL,
    "business_profile_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_business_profile_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_credentials" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "nonce" BYTEA NOT NULL,
    "auth_tag" BYTEA,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_accounts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "business_profile_id" TEXT NOT NULL,
    "channel" "ChannelType" NOT NULL,
    "external_account_id" TEXT NOT NULL,
    "display_name" TEXT,
    "credential_id" TEXT,
    "status" "ChannelAccountStatus" NOT NULL DEFAULT 'CONNECTED',
    "capabilities" JSONB NOT NULL DEFAULT '{}',
    "default_ai_mode" "AiMode" NOT NULL DEFAULT 'OFF',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "business_profile_id" TEXT NOT NULL,
    "channel_account_id" TEXT NOT NULL,
    "source_event_id" TEXT NOT NULL,
    "event_type" "ChannelEventType" NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "inbound_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "business_profile_id" TEXT NOT NULL,
    "display_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_identities" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "business_profile_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "channel_account_id" TEXT NOT NULL,
    "external_user_id" TEXT NOT NULL,
    "display_name" TEXT,
    "username" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "business_profile_id" TEXT NOT NULL,
    "channel_account_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "channel_identity_id" TEXT NOT NULL,
    "mode_override" "AiMode",
    "ai_enabled" BOOLEAN NOT NULL DEFAULT true,
    "takeover_state" "TakeoverState" NOT NULL DEFAULT 'NONE',
    "takeover_reason" "TakeoverReason",
    "takeover_review_mode" "ReviewMode",
    "human_takeover_at" TIMESTAMP(3),
    "takeover_paused_until" TIMESTAMP(3),
    "takeover_actor_kind" "ActorKind",
    "takeover_actor_user_id" TEXT,
    "review_eligibility_snapshot" JSONB,
    "lead_stage" "LeadStage" NOT NULL DEFAULT 'NEW',
    "status" "ConversationStatus" NOT NULL DEFAULT 'OPEN',
    "state_version" INTEGER NOT NULL DEFAULT 0,
    "last_inbound_at" TIMESTAMP(3),
    "last_outbound_at" TIMESTAMP(3),
    "last_message_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "business_profile_id" TEXT NOT NULL,
    "channel_account_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "channel_message_id" TEXT,
    "direction" "MessageDirection" NOT NULL,
    "source" "MessageSource" NOT NULL,
    "kind" "MessageKind" NOT NULL,
    "text" TEXT,
    "media" JSONB NOT NULL DEFAULT '[]',
    "reply_to_channel_message_id" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "delivery_status" "MessageDeliveryStatus",
    "delivered_at" TIMESTAMP(3),
    "read_at" TIMESTAMP(3),
    "transport_path" "OutboundTransportPath",
    "operation_id" TEXT,
    "ai_draft_id" TEXT,
    "sent_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_drafts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "business_profile_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "anchor_message_id" TEXT NOT NULL,
    "anchor_state_version" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "structured_output" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "model_suggests_send" BOOLEAN NOT NULL,
    "needs_review" BOOLEAN NOT NULL,
    "reason_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "intent" TEXT,
    "suggested_lead_stage" "LeadStage",
    "suggested_action" TEXT,
    "factual_source_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "AiDraftStatus" NOT NULL DEFAULT 'PENDING',
    "model_provider" TEXT NOT NULL,
    "model_name" TEXT NOT NULL,
    "prompt_version" TEXT NOT NULL,
    "schema_version" TEXT NOT NULL,
    "provider_request_id" TEXT,
    "latency_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_jobs" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "business_profile_id" TEXT NOT NULL,
    "draft_id" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "status" "DeliveryJobStatus" NOT NULL DEFAULT 'SCHEDULED',
    "scheduled_for" TIMESTAMP(3) NOT NULL,
    "selected_delay_ms" INTEGER NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "claimed_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "cancel_reason" TEXT,
    "platform_message_id" TEXT,
    "provider_request_id" TEXT,
    "last_error_code" TEXT,
    "last_error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_documents" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "business_profile_id" TEXT,
    "title" TEXT NOT NULL,
    "source_type" "KnowledgeSourceType" NOT NULL,
    "source_uri" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "KnowledgeDocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "content_hash" TEXT,
    "created_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_chunks" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "document_version" INTEGER NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "token_count" INTEGER,
    "embedding_profile" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "style_examples" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "business_profile_id" TEXT,
    "inbound_context" TEXT NOT NULL,
    "outbound_text" TEXT NOT NULL,
    "provenance" "StyleExampleProvenance" NOT NULL,
    "source_message_id" TEXT,
    "source_draft_id" TEXT,
    "approved_by_user_id" TEXT,
    "status" "StyleExampleStatus" NOT NULL DEFAULT 'ACTIVE',
    "embedding_profile" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "style_examples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_policies" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "business_profile_id" TEXT NOT NULL,
    "channel_account_id" TEXT,
    "mode" "AiMode" NOT NULL DEFAULT 'OFF',
    "confidence_threshold" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "mandatory_review_reasons" TEXT[],
    "debounce_min_ms" INTEGER NOT NULL DEFAULT 7000,
    "debounce_max_ms" INTEGER NOT NULL DEFAULT 12000,
    "delivery_delay_min_ms" INTEGER NOT NULL DEFAULT 30000,
    "delivery_delay_max_ms" INTEGER NOT NULL DEFAULT 120000,
    "quiet_hours_time_zone" TEXT,
    "quiet_hours_start" TEXT,
    "quiet_hours_end" TEXT,
    "takeover_pause_ms" INTEGER NOT NULL DEFAULT 21600000,
    "instagram_after_window_policy" "InstagramAfterWindowPolicy" NOT NULL DEFAULT 'STANDARD_ONLY',
    "whatsapp_after_window_policy" "WhatsAppAfterWindowPolicy" NOT NULL DEFAULT 'SERVICE_WINDOW_ONLY',
    "whatsapp_template_automation_allowlist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "auth_accounts_user_id_idx" ON "auth_accounts"("user_id");

-- CreateIndex
CREATE INDEX "auth_sessions_user_id_idx" ON "auth_sessions"("user_id");

-- CreateIndex
CREATE INDEX "workspace_members_user_id_idx" ON "workspace_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_members_workspace_id_user_id_key" ON "workspace_members"("workspace_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_members_workspace_id_id_key" ON "workspace_members"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "business_profiles_workspace_id_status_idx" ON "business_profiles"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "business_profiles_workspace_id_id_key" ON "business_profiles"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "member_business_profile_access_workspace_id_business_profil_idx" ON "member_business_profile_access"("workspace_id", "business_profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "member_business_profile_access_workspace_member_id_business_key" ON "member_business_profile_access"("workspace_member_id", "business_profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_credentials_workspace_id_id_key" ON "channel_credentials"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "channel_accounts_channel_external_account_id_idx" ON "channel_accounts"("channel", "external_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_accounts_workspace_id_business_profile_id_id_key" ON "channel_accounts"("workspace_id", "business_profile_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_accounts_workspace_id_credential_id_key" ON "channel_accounts"("workspace_id", "credential_id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_accounts_live_external_account_key" ON "channel_accounts"("channel", "external_account_id") WHERE (status <> 'DISCONNECTED');

-- CreateIndex
CREATE UNIQUE INDEX "channel_accounts_live_profile_channel_key" ON "channel_accounts"("business_profile_id", "channel") WHERE (status <> 'DISCONNECTED');

-- CreateIndex
CREATE INDEX "inbound_events_workspace_id_received_at_idx" ON "inbound_events"("workspace_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_events_source_event_key" ON "inbound_events"("workspace_id", "business_profile_id", "channel_account_id", "source_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_workspace_id_business_profile_id_id_key" ON "contacts"("workspace_id", "business_profile_id", "id");

-- CreateIndex
CREATE INDEX "channel_identities_workspace_id_business_profile_id_contact_idx" ON "channel_identities"("workspace_id", "business_profile_id", "contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_identities_workspace_id_business_profile_id_channel_key" ON "channel_identities"("workspace_id", "business_profile_id", "channel_account_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_identities_external_user_key" ON "channel_identities"("workspace_id", "business_profile_id", "channel_account_id", "external_user_id");

-- CreateIndex
CREATE INDEX "conversations_profile_inbox_idx" ON "conversations"("workspace_id", "business_profile_id", "status", "last_message_at" DESC);

-- CreateIndex
CREATE INDEX "conversations_channel_account_id_last_inbound_at_idx" ON "conversations"("channel_account_id", "last_inbound_at");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_workspace_id_business_profile_id_id_key" ON "conversations"("workspace_id", "business_profile_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_workspace_id_business_profile_id_channel_acco_key" ON "conversations"("workspace_id", "business_profile_id", "channel_account_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_channel_identity_key" ON "conversations"("workspace_id", "business_profile_id", "channel_account_id", "channel_identity_id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_operation_id_key" ON "messages"("operation_id");

-- CreateIndex
CREATE INDEX "messages_conversation_id_occurred_at_idx" ON "messages"("conversation_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "messages_workspace_id_business_profile_id_id_key" ON "messages"("workspace_id", "business_profile_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_workspace_id_business_profile_id_conversation_id_i_key" ON "messages"("workspace_id", "business_profile_id", "conversation_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_channel_message_key" ON "messages"("workspace_id", "business_profile_id", "channel_account_id", "channel_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_ai_draft_key" ON "messages"("workspace_id", "business_profile_id", "ai_draft_id");

-- CreateIndex
CREATE INDEX "ai_drafts_conversation_id_created_at_idx" ON "ai_drafts"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_drafts_workspace_id_business_profile_id_status_idx" ON "ai_drafts"("workspace_id", "business_profile_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ai_drafts_workspace_id_business_profile_id_id_key" ON "ai_drafts"("workspace_id", "business_profile_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_jobs_operation_id_key" ON "delivery_jobs"("operation_id");

-- CreateIndex
CREATE INDEX "delivery_jobs_status_scheduled_for_idx" ON "delivery_jobs"("status", "scheduled_for");

-- CreateIndex
CREATE INDEX "delivery_jobs_workspace_id_business_profile_id_status_idx" ON "delivery_jobs"("workspace_id", "business_profile_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_jobs_draft_key" ON "delivery_jobs"("workspace_id", "business_profile_id", "draft_id");

-- CreateIndex
CREATE INDEX "knowledge_documents_workspace_id_business_profile_id_status_idx" ON "knowledge_documents"("workspace_id", "business_profile_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_documents_workspace_id_id_key" ON "knowledge_documents"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_chunks_position_key" ON "knowledge_chunks"("workspace_id", "document_id", "document_version", "ordinal");

-- CreateIndex
CREATE INDEX "style_examples_workspace_id_business_profile_id_status_idx" ON "style_examples"("workspace_id", "business_profile_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "automation_policies_profile_default_key" ON "automation_policies"("workspace_id", "business_profile_id") WHERE (channel_account_id IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "automation_policies_channel_override_key" ON "automation_policies"("workspace_id", "business_profile_id", "channel_account_id");

-- AddForeignKey
ALTER TABLE "auth_accounts" ADD CONSTRAINT "auth_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "business_profiles" ADD CONSTRAINT "business_profiles_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "member_business_profile_access" ADD CONSTRAINT "member_business_profile_access_workspace_id_workspace_memb_fkey" FOREIGN KEY ("workspace_id", "workspace_member_id") REFERENCES "workspace_members"("workspace_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "member_business_profile_access" ADD CONSTRAINT "member_business_profile_access_workspace_id_business_profi_fkey" FOREIGN KEY ("workspace_id", "business_profile_id") REFERENCES "business_profiles"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "channel_credentials" ADD CONSTRAINT "channel_credentials_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "channel_accounts" ADD CONSTRAINT "channel_accounts_workspace_id_business_profile_id_fkey" FOREIGN KEY ("workspace_id", "business_profile_id") REFERENCES "business_profiles"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "channel_accounts" ADD CONSTRAINT "channel_accounts_workspace_id_credential_id_fkey" FOREIGN KEY ("workspace_id", "credential_id") REFERENCES "channel_credentials"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_workspace_id_business_profile_id_channel_ac_fkey" FOREIGN KEY ("workspace_id", "business_profile_id", "channel_account_id") REFERENCES "channel_accounts"("workspace_id", "business_profile_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_workspace_id_business_profile_id_fkey" FOREIGN KEY ("workspace_id", "business_profile_id") REFERENCES "business_profiles"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "channel_identities" ADD CONSTRAINT "channel_identities_workspace_id_business_profile_id_contac_fkey" FOREIGN KEY ("workspace_id", "business_profile_id", "contact_id") REFERENCES "contacts"("workspace_id", "business_profile_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "channel_identities" ADD CONSTRAINT "channel_identities_workspace_id_business_profile_id_channe_fkey" FOREIGN KEY ("workspace_id", "business_profile_id", "channel_account_id") REFERENCES "channel_accounts"("workspace_id", "business_profile_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_workspace_id_business_profile_id_channel_acc_fkey" FOREIGN KEY ("workspace_id", "business_profile_id", "channel_account_id", "channel_identity_id") REFERENCES "channel_identities"("workspace_id", "business_profile_id", "channel_account_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_workspace_id_business_profile_id_contact_id_fkey" FOREIGN KEY ("workspace_id", "business_profile_id", "contact_id") REFERENCES "contacts"("workspace_id", "business_profile_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_takeover_actor_user_id_fkey" FOREIGN KEY ("takeover_actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_workspace_id_business_profile_id_channel_account__fkey" FOREIGN KEY ("workspace_id", "business_profile_id", "channel_account_id", "conversation_id") REFERENCES "conversations"("workspace_id", "business_profile_id", "channel_account_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_workspace_id_business_profile_id_ai_draft_id_fkey" FOREIGN KEY ("workspace_id", "business_profile_id", "ai_draft_id") REFERENCES "ai_drafts"("workspace_id", "business_profile_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_sent_by_user_id_fkey" FOREIGN KEY ("sent_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ai_drafts" ADD CONSTRAINT "ai_drafts_conversation_fkey" FOREIGN KEY ("workspace_id", "business_profile_id", "conversation_id") REFERENCES "conversations"("workspace_id", "business_profile_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ai_drafts" ADD CONSTRAINT "ai_drafts_anchor_message_fkey" FOREIGN KEY ("workspace_id", "business_profile_id", "conversation_id", "anchor_message_id") REFERENCES "messages"("workspace_id", "business_profile_id", "conversation_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "delivery_jobs" ADD CONSTRAINT "delivery_jobs_workspace_id_business_profile_id_draft_id_fkey" FOREIGN KEY ("workspace_id", "business_profile_id", "draft_id") REFERENCES "ai_drafts"("workspace_id", "business_profile_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_workspace_id_business_profile_id_fkey" FOREIGN KEY ("workspace_id", "business_profile_id") REFERENCES "business_profiles"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_workspace_id_document_id_fkey" FOREIGN KEY ("workspace_id", "document_id") REFERENCES "knowledge_documents"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "style_examples" ADD CONSTRAINT "style_examples_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "style_examples" ADD CONSTRAINT "style_examples_workspace_id_business_profile_id_fkey" FOREIGN KEY ("workspace_id", "business_profile_id") REFERENCES "business_profiles"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "style_examples" ADD CONSTRAINT "style_examples_workspace_id_business_profile_id_source_mes_fkey" FOREIGN KEY ("workspace_id", "business_profile_id", "source_message_id") REFERENCES "messages"("workspace_id", "business_profile_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "style_examples" ADD CONSTRAINT "style_examples_workspace_id_business_profile_id_source_dra_fkey" FOREIGN KEY ("workspace_id", "business_profile_id", "source_draft_id") REFERENCES "ai_drafts"("workspace_id", "business_profile_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "style_examples" ADD CONSTRAINT "style_examples_approved_by_user_id_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "automation_policies" ADD CONSTRAINT "automation_policies_workspace_id_business_profile_id_fkey" FOREIGN KEY ("workspace_id", "business_profile_id") REFERENCES "business_profiles"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "automation_policies" ADD CONSTRAINT "automation_policies_workspace_id_business_profile_id_chann_fkey" FOREIGN KEY ("workspace_id", "business_profile_id", "channel_account_id") REFERENCES "channel_accounts"("workspace_id", "business_profile_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ---------------------------------------------------------------------------------------------------------
-- Integrity rules Prisma schema cannot express (hand-written; covered by packages/db constraint tests).
-- ---------------------------------------------------------------------------------------------------------

-- Human takeover state carries exactly the fields its variant needs (domain HumanTakeoverState).
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_takeover_state_check" CHECK (
  (
    "takeover_state" = 'NONE'
    AND "takeover_reason" IS NULL AND "takeover_review_mode" IS NULL AND "human_takeover_at" IS NULL
    AND "takeover_paused_until" IS NULL AND "takeover_actor_kind" IS NULL
  )
  OR (
    "takeover_state" = 'REVIEW_REQUIRED'
    AND "takeover_reason" IS NOT NULL AND "takeover_review_mode" IS NOT NULL AND "human_takeover_at" IS NOT NULL
    AND "takeover_paused_until" IS NULL AND "takeover_actor_kind" IS NULL
  )
  OR (
    "takeover_state" = 'HUMAN_ACTIVE'
    AND "takeover_reason" IS NOT NULL AND "takeover_review_mode" IS NULL AND "human_takeover_at" IS NOT NULL
  )
);

-- A USER actor always names the user; other actors never do.
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_takeover_actor_user_check" CHECK (
  (COALESCE("takeover_actor_kind"::text, '') = 'USER') = ("takeover_actor_user_id" IS NOT NULL)
);

-- Inbound rows come from the participant and carry no outbound metadata; outbound rows never do.
ALTER TABLE "messages" ADD CONSTRAINT "messages_direction_source_check" CHECK (
  (
    "direction" = 'IN' AND "source" = 'PARTICIPANT'
    AND "transport_path" IS NULL AND "operation_id" IS NULL AND "ai_draft_id" IS NULL AND "sent_by_user_id" IS NULL
  )
  OR ("direction" = 'OUT' AND "source" <> 'PARTICIPANT')
);

-- Human Agent sends are human-initiated and keep the acting user for audit (ADR-014, DATA_MODEL.md).
ALTER TABLE "messages" ADD CONSTRAINT "messages_human_agent_actor_check" CHECK (
  "transport_path" IS DISTINCT FROM 'HUMAN_AGENT' OR ("source" = 'HUMAN' AND "sent_by_user_id" IS NOT NULL)
);

ALTER TABLE "ai_drafts" ADD CONSTRAINT "ai_drafts_confidence_check" CHECK (
  "confidence" >= 0 AND "confidence" <= 1 AND ("latency_ms" IS NULL OR "latency_ms" >= 0)
);

-- A SENT delivery job always records the provider-accepted platform message.
ALTER TABLE "delivery_jobs" ADD CONSTRAINT "delivery_jobs_sent_check" CHECK (
  "status" <> 'SENT' OR ("sent_at" IS NOT NULL AND "platform_message_id" IS NOT NULL)
);

ALTER TABLE "delivery_jobs" ADD CONSTRAINT "delivery_jobs_counters_check" CHECK (
  "selected_delay_ms" >= 0 AND "attempt_count" >= 0
);

ALTER TABLE "automation_policies" ADD CONSTRAINT "automation_policies_ranges_check" CHECK (
  "confidence_threshold" >= 0 AND "confidence_threshold" <= 1
  AND "debounce_min_ms" >= 0 AND "debounce_min_ms" <= "debounce_max_ms"
  AND "delivery_delay_min_ms" >= 0 AND "delivery_delay_min_ms" <= "delivery_delay_max_ms"
  AND "takeover_pause_ms" > 0
);

ALTER TABLE "automation_policies" ADD CONSTRAINT "automation_policies_quiet_hours_check" CHECK (
  ("quiet_hours_time_zone" IS NULL) = ("quiet_hours_start" IS NULL)
  AND ("quiet_hours_start" IS NULL) = ("quiet_hours_end" IS NULL)
);

-- An edited-draft style example must point at the draft it came from.
ALTER TABLE "style_examples" ADD CONSTRAINT "style_examples_provenance_check" CHECK (
  "provenance" <> 'HUMAN_EDITED_DRAFT' OR "source_draft_id" IS NOT NULL
);

ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_version_check" CHECK ("version" >= 1);

ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_position_check" CHECK (
  "document_version" >= 1 AND "ordinal" >= 0
);

-- Business Profile scope (DATA_MODEL.md v0.4, Issue #53) --------------------------------------------------

-- OWNER has full Workspace authority and therefore every Business Profile.
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_owner_scope_check" CHECK (
  "role" <> 'OWNER' OR "business_profile_scope" = 'ALL'
);

ALTER TABLE "conversations" ADD CONSTRAINT "conversations_state_version_check" CHECK ("state_version" >= 0);

ALTER TABLE "ai_drafts" ADD CONSTRAINT "ai_drafts_anchor_state_version_check" CHECK ("anchor_state_version" >= 0);

-- Style learned from a conversation belongs to that conversation's Business Profile. With a NULL profile the
-- composite source FKs would not be checked (MATCH SIMPLE), so sources require the profile to be set.
ALTER TABLE "style_examples" ADD CONSTRAINT "style_examples_source_profile_check" CHECK (
  ("source_message_id" IS NULL AND "source_draft_id" IS NULL) OR "business_profile_id" IS NOT NULL
);
