-- How a business sounds (product-owner decision on PR #65).
--
-- A persona in an environment variable belongs to the deployment, so every tenant on it sounds the same
-- and no business can change its own voice without a release. This table makes the voice customer-owned:
-- a Workspace base row, and an optional override per Business Profile. Phase 5 builds the editing UI; the
-- runtime consumes the resolved shape from here now so the persona never has to be un-baked later.

CREATE TYPE "ReplyLength" AS ENUM ('SHORT', 'MEDIUM', 'LONG');
CREATE TYPE "EmojiUsage" AS ENUM ('NONE', 'SPARING', 'FREELY');

CREATE TABLE "style_profiles" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "business_profile_id" TEXT,
    "persona" TEXT,
    "tone" TEXT,
    "reply_length" "ReplyLength",
    "emoji" "EmojiUsage",
    "greeting" TEXT,
    "sign_off" TEXT,
    "preferred_phrases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "avoided_phrases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "language" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "style_profiles_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "style_profiles"
  ADD CONSTRAINT "style_profiles_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "style_profiles"
  ADD CONSTRAINT "style_profiles_business_profile_fkey"
  FOREIGN KEY ("workspace_id", "business_profile_id") REFERENCES "business_profiles"("workspace_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- At most one base voice per Workspace and one override per Business Profile. Two partial indexes rather
-- than one unique constraint, because in a plain unique index a NULL never equals another NULL — so every
-- Workspace could accumulate any number of "base" rows and the resolution order would stop being defined.
CREATE UNIQUE INDEX "style_profiles_workspace_base_key"
  ON "style_profiles"("workspace_id") WHERE "business_profile_id" IS NULL;
CREATE UNIQUE INDEX "style_profiles_business_profile_key"
  ON "style_profiles"("workspace_id", "business_profile_id") WHERE "business_profile_id" IS NOT NULL;
