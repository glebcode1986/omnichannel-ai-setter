-- Customer identity and durable memory, inside one Business Profile (Issue #54).
--
-- The whole design question here is what the product refuses to remember, so the refusals are in the
-- schema rather than in the code that happens to write it.
--
-- **There is no enum value for a trait we will not store.** `CustomerFactCategory` lists what a business
-- may legitimately remember about somebody who wrote to it: how to reach them, what they bought, what
-- they asked for, constraints they stated, and what they consented to. There is deliberately no category
-- for inferred wealth, vulnerability, or psychological profile — not a CHECK forbidding them, but no
-- value to put them in. A future writer cannot store one by forgetting a rule, only by writing a
-- migration that adds the value, which is a decision somebody has to make on purpose.
--
-- **The AI cannot make a fact authoritative.** A model may propose; only a person confirms. A CHECK
-- requires a confirming member for any ACTIVE fact or preference, so model output sits at SUGGESTED and
-- nothing that reads memory as authority can see it.
--
-- **Nothing crosses a Business Profile.** Every table is profile-scoped through a composite foreign key,
-- and a duplicate suggestion can only name two contacts in the same profile — so the same phone number in
-- two profiles stays two unrelated customers, which is the point rather than a limitation.

-- What a business may remember. See the note above about what is missing and why.
CREATE TYPE "CustomerFactCategory" AS ENUM (
  -- How to reach them, and when they prefer to be reached.
  'CONTACT_PREFERENCE',
  -- What they have bought, booked or attended with this business.
  'SERVICE_HISTORY',
  -- What they have asked for, in their own terms.
  'STATED_REQUIREMENT',
  -- Constraints they have stated: an address, a travel limit, an accessibility need they chose to share.
  'LOGISTICS',
  -- What they agreed to, which is the one category that exists to protect them.
  'CONSENT'
);

-- Who says so. There is no value that means "the model decided", because a model proposing is a
-- suggestion and the source of a suggestion is still the model that made it.
CREATE TYPE "CustomerFactSource" AS ENUM ('CUSTOMER_STATED', 'HUMAN_RECORDED', 'AI_SUGGESTED');

CREATE TYPE "CustomerFactStatus" AS ENUM (
  -- Proposed and not in use. A CHECK keeps an unconfirmed entry out of ACTIVE.
  'SUGGESTED',
  'ACTIVE',
  -- Replaced by a newer entry for the same subject; kept, because how a fact changed is part of it.
  'SUPERSEDED',
  -- Past its own expiry. Kept for the same reason.
  'EXPIRED'
);

CREATE TYPE "ContactPointKind" AS ENUM ('PHONE', 'EMAIL');

-- How much this contact point is worth as identity evidence.
--
-- `PROVIDER_VERIFIED` is the only level strong enough to associate two identities automatically. A
-- customer typing a phone number into a chat is worth recording and is not proof of anything: people
-- mistype, and people give a partner's number.
CREATE TYPE "ContactPointVerification" AS ENUM ('UNVERIFIED', 'CUSTOMER_STATED', 'PROVIDER_VERIFIED');

-- A phone number or an email address, belonging to one contact in one Business Profile.
CREATE TABLE "contact_points" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" TEXT NOT NULL,
  "business_profile_id" TEXT NOT NULL,
  "contact_id" TEXT NOT NULL,
  "kind" "ContactPointKind" NOT NULL,
  -- Normalized for comparison — E.164 for a phone, lowercased for an email — so two spellings of one
  -- number are one contact point rather than two weak matches.
  "normalized_value" TEXT NOT NULL,
  -- Exactly as the customer gave it, because that is what an operator recognises on screen.
  "raw_value" TEXT NOT NULL,
  "verification" "ContactPointVerification" NOT NULL DEFAULT 'UNVERIFIED',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "contact_points_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "contact_points"
  ADD CONSTRAINT "contact_points_contact_fkey"
  FOREIGN KEY ("workspace_id", "business_profile_id", "contact_id") REFERENCES "contacts"("workspace_id", "business_profile_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "contact_points" ADD CONSTRAINT "contact_points_value_check" CHECK (
  btrim("normalized_value") <> '' AND btrim("raw_value") <> ''
);

-- One contact point per value per Business Profile. Scoped to the profile on purpose: the same number in
-- another profile is another customer, and a unique index across profiles would be the cross-business
-- identity graph this task exists to avoid.
CREATE UNIQUE INDEX "contact_points_value_key"
  ON "contact_points" ("workspace_id", "business_profile_id", "kind", "normalized_value");

CREATE INDEX "contact_points_contact_idx" ON "contact_points" ("workspace_id", "business_profile_id", "contact_id");

-- An id this customer has in a system outside the product: a booking tool, a CRM, a till.
CREATE TABLE "external_identities" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" TEXT NOT NULL,
  "business_profile_id" TEXT NOT NULL,
  "contact_id" TEXT NOT NULL,
  -- The business's own name for the system. Free text because we do not know their stack.
  "system" TEXT NOT NULL,
  "external_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "external_identities_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "external_identities"
  ADD CONSTRAINT "external_identities_contact_fkey"
  FOREIGN KEY ("workspace_id", "business_profile_id", "contact_id") REFERENCES "contacts"("workspace_id", "business_profile_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_value_check" CHECK (
  btrim("system") <> '' AND btrim("external_id") <> ''
);

CREATE UNIQUE INDEX "external_identities_value_key"
  ON "external_identities" ("workspace_id", "business_profile_id", "system", "external_id");

-- A durable thing the business knows about a customer.
CREATE TABLE "customer_facts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" TEXT NOT NULL,
  "business_profile_id" TEXT NOT NULL,
  "contact_id" TEXT NOT NULL,
  "category" "CustomerFactCategory" NOT NULL,
  -- What the fact is about, so a newer entry can supersede the right older one.
  "subject" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "source" "CustomerFactSource" NOT NULL,
  "status" "CustomerFactStatus" NOT NULL DEFAULT 'SUGGESTED',
  -- Where it came from, so an operator can go and read it: the message or the draft that proposed it.
  "source_message_id" TEXT,
  "source_draft_id" TEXT,
  -- The member who made it authoritative. A CHECK requires one for ACTIVE.
  "confirmed_by_user_id" TEXT,
  "confirmed_at" TIMESTAMP(3),
  -- When this stops being true by itself. NULL means it does not expire on its own, not that it is
  -- permanent: superseding still replaces it.
  "expires_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "customer_facts_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "customer_facts"
  ADD CONSTRAINT "customer_facts_contact_fkey"
  FOREIGN KEY ("workspace_id", "business_profile_id", "contact_id") REFERENCES "contacts"("workspace_id", "business_profile_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "customer_facts"
  ADD CONSTRAINT "customer_facts_message_fkey"
  FOREIGN KEY ("workspace_id", "business_profile_id", "source_message_id") REFERENCES "messages"("workspace_id", "business_profile_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "customer_facts"
  ADD CONSTRAINT "customer_facts_draft_fkey"
  FOREIGN KEY ("workspace_id", "business_profile_id", "source_draft_id") REFERENCES "ai_drafts"("workspace_id", "business_profile_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "customer_facts"
  ADD CONSTRAINT "customer_facts_confirmer_fkey"
  FOREIGN KEY ("confirmed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "customer_facts" ADD CONSTRAINT "customer_facts_text_check" CHECK (
  btrim("subject") <> '' AND btrim("value") <> ''
);

-- The invariant the issue names: model output cannot become an authoritative customer fact. Only a person
-- makes a fact ACTIVE, and the row records which person and when.
ALTER TABLE "customer_facts" ADD CONSTRAINT "customer_facts_authority_check" CHECK (
  "status" <> 'ACTIVE' OR ("confirmed_by_user_id" IS NOT NULL AND "confirmed_at" IS NOT NULL)
);

-- A confirmation is a person and a time together, or neither.
ALTER TABLE "customer_facts" ADD CONSTRAINT "customer_facts_confirmation_check" CHECK (
  ("confirmed_by_user_id" IS NULL) = ("confirmed_at" IS NULL)
);

-- A fact the model proposed says which draft proposed it, so an operator can read the reply it came from
-- before believing it.
ALTER TABLE "customer_facts" ADD CONSTRAINT "customer_facts_ai_provenance_check" CHECK (
  "source" <> 'AI_SUGGESTED' OR "source_draft_id" IS NOT NULL
);

-- At most one ACTIVE entry per subject: memory that contradicted itself would be worse than no memory.
CREATE UNIQUE INDEX "customer_facts_active_subject_key"
  ON "customer_facts" ("workspace_id", "business_profile_id", "contact_id", "category", "subject")
  WHERE "status" = 'ACTIVE';

CREATE INDEX "customer_facts_contact_idx" ON "customer_facts" ("workspace_id", "business_profile_id", "contact_id", "status");

-- A preference is what they would rather. Its own table because a preference is not a fact about the
-- world: "prefers mornings" is not the same kind of claim as "booked on the 4th", and merging them would
-- let a preference be cited as evidence.
CREATE TABLE "customer_preferences" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" TEXT NOT NULL,
  "business_profile_id" TEXT NOT NULL,
  "contact_id" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "source" "CustomerFactSource" NOT NULL,
  "status" "CustomerFactStatus" NOT NULL DEFAULT 'SUGGESTED',
  "source_message_id" TEXT,
  "source_draft_id" TEXT,
  "confirmed_by_user_id" TEXT,
  "confirmed_at" TIMESTAMP(3),
  "expires_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "customer_preferences_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "customer_preferences"
  ADD CONSTRAINT "customer_preferences_contact_fkey"
  FOREIGN KEY ("workspace_id", "business_profile_id", "contact_id") REFERENCES "contacts"("workspace_id", "business_profile_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "customer_preferences"
  ADD CONSTRAINT "customer_preferences_confirmer_fkey"
  FOREIGN KEY ("confirmed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "customer_preferences" ADD CONSTRAINT "customer_preferences_text_check" CHECK (
  btrim("subject") <> '' AND btrim("value") <> ''
);

ALTER TABLE "customer_preferences" ADD CONSTRAINT "customer_preferences_authority_check" CHECK (
  "status" <> 'ACTIVE' OR ("confirmed_by_user_id" IS NOT NULL AND "confirmed_at" IS NOT NULL)
);

ALTER TABLE "customer_preferences" ADD CONSTRAINT "customer_preferences_confirmation_check" CHECK (
  ("confirmed_by_user_id" IS NULL) = ("confirmed_at" IS NULL)
);

ALTER TABLE "customer_preferences" ADD CONSTRAINT "customer_preferences_ai_provenance_check" CHECK (
  "source" <> 'AI_SUGGESTED' OR "source_draft_id" IS NOT NULL
);

CREATE UNIQUE INDEX "customer_preferences_active_subject_key"
  ON "customer_preferences" ("workspace_id", "business_profile_id", "contact_id", "subject")
  WHERE "status" = 'ACTIVE';

CREATE INDEX "customer_preferences_contact_idx" ON "customer_preferences" ("workspace_id", "business_profile_id", "contact_id", "status");

-- A summary of one conversation, written by a model, and assistive only.
--
-- Its own table, kept away from `customer_facts`, because a summary is the model's reading of a thread
-- and not something the business knows. Nothing that reads memory as authority reads this, and it has no
-- confirmation column at all — there is nothing here for a person to make authoritative, which is the
-- honest shape of "assistive only".
CREATE TABLE "conversation_summaries" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" TEXT NOT NULL,
  "business_profile_id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  -- The model's own identity, because a summary is only as good as what wrote it.
  "model_provider" TEXT NOT NULL,
  "model_name" TEXT NOT NULL,
  -- How far through the thread this summary reads, so a stale one is recognisable rather than trusted.
  "covers_message_id" TEXT,
  -- Ephemeral context expires. A summary with no expiry is one somebody has to decide to keep.
  "expires_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "conversation_summaries_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "conversation_summaries"
  ADD CONSTRAINT "conversation_summaries_conversation_fkey"
  FOREIGN KEY ("workspace_id", "business_profile_id", "conversation_id") REFERENCES "conversations"("workspace_id", "business_profile_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "conversation_summaries" ADD CONSTRAINT "conversation_summaries_text_check" CHECK (
  btrim("summary") <> ''
);

-- One current summary per conversation; a newer one replaces it rather than accumulating.
CREATE UNIQUE INDEX "conversation_summaries_conversation_key"
  ON "conversation_summaries" ("workspace_id", "business_profile_id", "conversation_id");

-- Two contacts that might be the same person. A suggestion, never a merge.
CREATE TABLE "duplicate_contact_candidates" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" TEXT NOT NULL,
  "business_profile_id" TEXT NOT NULL,
  -- Ordered by id in the store, so one pair cannot become two rows facing each other.
  "contact_id" TEXT NOT NULL,
  "other_contact_id" TEXT NOT NULL,
  -- Why we think so, in the store's own words, so an operator can judge the guess.
  "reason" TEXT NOT NULL,
  -- Set when somebody has looked: kept rather than deleted, so the same guess is not offered forever.
  "dismissed_by_user_id" TEXT,
  "dismissed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "duplicate_contact_candidates_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "duplicate_contact_candidates"
  ADD CONSTRAINT "duplicate_contact_candidates_contact_fkey"
  FOREIGN KEY ("workspace_id", "business_profile_id", "contact_id") REFERENCES "contacts"("workspace_id", "business_profile_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Both sides in the same Business Profile, by construction: a candidate across profiles is the
-- cross-business identity graph this task refuses to build.
ALTER TABLE "duplicate_contact_candidates"
  ADD CONSTRAINT "duplicate_contact_candidates_other_fkey"
  FOREIGN KEY ("workspace_id", "business_profile_id", "other_contact_id") REFERENCES "contacts"("workspace_id", "business_profile_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "duplicate_contact_candidates"
  ADD CONSTRAINT "duplicate_contact_candidates_dismisser_fkey"
  FOREIGN KEY ("dismissed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A contact is not its own duplicate.
ALTER TABLE "duplicate_contact_candidates" ADD CONSTRAINT "duplicate_contact_candidates_distinct_check" CHECK (
  "contact_id" <> "other_contact_id"
);

-- Ordered, so one pair is one row however it was discovered.
ALTER TABLE "duplicate_contact_candidates" ADD CONSTRAINT "duplicate_contact_candidates_order_check" CHECK (
  "contact_id" < "other_contact_id"
);

ALTER TABLE "duplicate_contact_candidates" ADD CONSTRAINT "duplicate_contact_candidates_dismissal_check" CHECK (
  ("dismissed_by_user_id" IS NULL) = ("dismissed_at" IS NULL)
);

ALTER TABLE "duplicate_contact_candidates" ADD CONSTRAINT "duplicate_contact_candidates_reason_check" CHECK (
  btrim("reason") <> ''
);

CREATE UNIQUE INDEX "duplicate_contact_candidates_pair_key"
  ON "duplicate_contact_candidates" ("workspace_id", "business_profile_id", "contact_id", "other_contact_id");
