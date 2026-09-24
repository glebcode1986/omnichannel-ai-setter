-- AlterTable
ALTER TABLE "channel_credentials" ADD COLUMN     "purpose" TEXT NOT NULL DEFAULT 'INSTAGRAM_ACCESS_TOKEN',
ADD COLUMN     "refreshed_at" TIMESTAMP(3),
ADD COLUMN     "revoked_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "channel_connect_states" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "business_profile_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "channel" "ChannelType" NOT NULL,
    "nonce_hash" BYTEA NOT NULL,
    "requested_scopes" TEXT[],
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_connect_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "channel_connect_states_expires_at_idx" ON "channel_connect_states"("expires_at");

-- AddForeignKey
ALTER TABLE "channel_connect_states" ADD CONSTRAINT "channel_connect_states_workspace_id_business_profile_id_fkey" FOREIGN KEY ("workspace_id", "business_profile_id") REFERENCES "business_profiles"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "channel_connect_states" ADD CONSTRAINT "channel_connect_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;



-- Hand-written integrity rules (see packages/db constraint tests).
-- A stored credential must be a complete AES-256-GCM envelope; a row that names another algorithm, drops the
-- authentication tag or carries a wrong-sized nonce is not storable at all.
ALTER TABLE "channel_credentials" ADD CONSTRAINT "channel_credentials_envelope_check" CHECK (
  "algorithm" = 'aes-256-gcm'
  AND octet_length("nonce") = 12
  AND "auth_tag" IS NOT NULL
  AND octet_length("auth_tag") = 16
  AND octet_length("ciphertext") > 0
  AND "purpose" <> ''
);
-- Lifetimes move forward: a credential cannot expire or be refreshed before it existed.
ALTER TABLE "channel_credentials" ADD CONSTRAINT "channel_credentials_lifetime_check" CHECK (
  ("expires_at" IS NULL OR "expires_at" > "created_at")
  AND ("refreshed_at" IS NULL OR "refreshed_at" >= "created_at")
  AND ("revoked_at" IS NULL OR "revoked_at" >= "created_at")
);
-- A connect state is short-lived and single-use; it can neither expire before it was created nor be
-- consumed before it existed.
ALTER TABLE "channel_connect_states" ADD CONSTRAINT "channel_connect_states_lifetime_check" CHECK (
  "expires_at" > "created_at"
  AND ("consumed_at" IS NULL OR "consumed_at" >= "created_at")
  AND octet_length("nonce_hash") = 32
);
