-- CreateEnum
CREATE TYPE "WhatsAppOnboardingMode" AS ENUM ('NEW_OR_MIGRATED_CLOUD_NUMBER', 'COEXISTENCE_EXISTING_BUSINESS_APP', 'UNKNOWN');

-- AlterEnum
ALTER TYPE "ChannelAccountStatus" ADD VALUE 'DEGRADED';

-- CreateTable
CREATE TABLE "whatsapp_connections" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "business_profile_id" TEXT NOT NULL,
    "channel_account_id" TEXT NOT NULL,
    "waba_id" TEXT NOT NULL,
    "business_portfolio_id" TEXT,
    "display_phone_number" TEXT,
    "verified_name" TEXT,
    "quality_rating" TEXT,
    "code_verification_status" TEXT,
    "platform_type" TEXT,
    "onboarding_mode" "WhatsAppOnboardingMode" NOT NULL DEFAULT 'UNKNOWN',
    "webhook_subscribed_at" TIMESTAMP(3),
    "phone_registered_at" TIMESTAMP(3),
    "templates_synced_at" TIMESTAMP(3),
    "templates_complete" BOOLEAN,
    "connected_at" TIMESTAMP(3),
    "health_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_message_templates" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "provider_template_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "category" TEXT,
    "status" TEXT NOT NULL,
    "components" JSONB,
    "synced_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_message_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "whatsapp_connections_waba_id_idx" ON "whatsapp_connections"("waba_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_connections_workspace_id_business_profile_id_chann_key" ON "whatsapp_connections"("workspace_id", "business_profile_id", "channel_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_connections_workspace_id_channel_account_id_key" ON "whatsapp_connections"("workspace_id", "channel_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_connections_workspace_id_id_key" ON "whatsapp_connections"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "whatsapp_message_templates_workspace_id_connection_id_statu_idx" ON "whatsapp_message_templates"("workspace_id", "connection_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_message_templates_workspace_id_connection_id_provi_key" ON "whatsapp_message_templates"("workspace_id", "connection_id", "provider_template_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_message_templates_workspace_id_connection_id_name__key" ON "whatsapp_message_templates"("workspace_id", "connection_id", "name", "language");

-- AddForeignKey
ALTER TABLE "whatsapp_connections" ADD CONSTRAINT "whatsapp_connections_workspace_id_business_profile_id_fkey" FOREIGN KEY ("workspace_id", "business_profile_id") REFERENCES "business_profiles"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "whatsapp_connections" ADD CONSTRAINT "whatsapp_connections_workspace_id_business_profile_id_chan_fkey" FOREIGN KEY ("workspace_id", "business_profile_id", "channel_account_id") REFERENCES "channel_accounts"("workspace_id", "business_profile_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "whatsapp_message_templates" ADD CONSTRAINT "whatsapp_message_templates_workspace_id_connection_id_fkey" FOREIGN KEY ("workspace_id", "connection_id") REFERENCES "whatsapp_connections"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- WHATSAPP_ONBOARDING.md: "mark channel account connected only after required verification/subscription
-- succeeds." `connected_at` is that claim, written in the same transaction as the provider's own
-- confirmations — so the rule can be stated here, where it holds against this codebase, a later migration,
-- a console and anything written next.
--
-- The subscription is unconditional: without it no webhook for this customer is ever delivered, so a
-- connection claiming to be live would receive nothing and look healthy doing it.
ALTER TABLE "whatsapp_connections" ADD CONSTRAINT "whatsapp_connections_connected_subscribed_check" CHECK (
  "connected_at" IS NULL OR "webhook_subscribed_at" IS NOT NULL
);

-- Registration is required "where current Meta requires it" (same spec), and the one documented case where
-- it does not is a number onboarded from the WhatsApp Business App. The exemption is written out rather
-- than implied, so a reader can see exactly which mode is excused and why — and so that a future reading of
-- Meta's rules changes one named constraint instead of a condition buried in application code.
ALTER TABLE "whatsapp_connections" ADD CONSTRAINT "whatsapp_connections_connected_registered_check" CHECK (
  "connected_at" IS NULL
  OR "onboarding_mode" = 'COEXISTENCE_EXISTING_BUSINESS_APP'
  OR "phone_registered_at" IS NOT NULL
);

-- A sync time with no completeness, or completeness with no sync time, is a catalogue nobody can reason
-- about: "synced, and we do not know whether it is all of them" and "complete as of never" are both
-- states the template bootstrap must not be able to leave behind.
ALTER TABLE "whatsapp_connections" ADD CONSTRAINT "whatsapp_connections_templates_sync_check" CHECK (
  ("templates_synced_at" IS NULL) = ("templates_complete" IS NULL)
);

-- A connection that never finished has nothing to explain, but one that is degraded or disconnected does.
-- The reason is a fixed code written by this codebase, never provider prose, and it is the only thing an
-- operator has to go on when a number stops answering.
ALTER TABLE "whatsapp_connections" ADD CONSTRAINT "whatsapp_connections_health_reason_check" CHECK (
  "health_reason" IS NULL OR "health_reason" <> ''
);
