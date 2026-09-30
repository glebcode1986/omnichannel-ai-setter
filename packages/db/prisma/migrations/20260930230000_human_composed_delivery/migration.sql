-- A delivery has exactly one content origin: an AI draft, or a person's own words (ADR-018 Option B,
-- accepted 2026-09-30; Issue #29).
--
-- Until now a delivery required a `draft_id`, so a person replying where no draft existed had nowhere
-- honest to put their wording. The rejected alternative was to write it into `ai_drafts` — which would
-- have meant inventing `confidence`, `model_provider`, `model_name`, `prompt_version`, `schema_version`
-- and `model_suggests_send` for text no model produced, and every one of those invented values would have
-- flowed into `readReliabilitySnapshot`, `countUnusableGenerations` and the evals. `ai_drafts` stays
-- semantically model-only.
--
-- What changes is the delivery record, which gains an honest second origin. This is a fact about the
-- product — automation and people both reply — and the delivery now says on its face which one wrote what
-- went out, without a join.
--
-- The delivery coordinator remains the only path to a customer. A human-composed delivery is claimed,
-- revalidated, gated and sent by exactly the same code; nothing here adds a second send path.

ALTER TABLE "delivery_jobs" ALTER COLUMN "draft_id" DROP NOT NULL;

ALTER TABLE "delivery_jobs"
  ADD COLUMN "human_text" TEXT,
  ADD COLUMN "composed_by_user_id" TEXT;

ALTER TABLE "delivery_jobs"
  ADD CONSTRAINT "delivery_jobs_composed_by_fkey"
  FOREIGN KEY ("composed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Exactly one origin. Not "at least one" and not "at most one": a delivery with neither has nothing to
-- send, and one with both is two different messages wearing one operation id.
ALTER TABLE "delivery_jobs" ADD CONSTRAINT "delivery_jobs_one_origin_check" CHECK (
  ("draft_id" IS NOT NULL) <> ("human_text" IS NOT NULL)
);

-- Human-composed content names its author, and only human-composed content has one. A reply in somebody's
-- own words with nobody's name on it is unattributed rather than automatic, and an author on an AI draft
-- would claim a person wrote what a model produced.
ALTER TABLE "delivery_jobs" ADD CONSTRAINT "delivery_jobs_composer_check" CHECK (
  ("human_text" IS NOT NULL) = ("composed_by_user_id" IS NOT NULL)
);

-- Empty wording is not wording. Without this, "exactly one origin" would be satisfiable by an empty
-- string, and the transport would be asked to send nothing.
ALTER TABLE "delivery_jobs" ADD CONSTRAINT "delivery_jobs_human_text_check" CHECK (
  "human_text" IS NULL OR btrim("human_text") <> ''
);

-- A human-composed delivery is a person's deliberate act, so it can only carry a human authority. An
-- AUTOMATED one would claim automation sent words a person typed.
ALTER TABLE "delivery_jobs" ADD CONSTRAINT "delivery_jobs_human_authority_check" CHECK (
  "human_text" IS NULL OR "authority" = 'HUMAN_APPROVED'
);

-- Which conversation a human-composed delivery belongs to. An AI delivery derives it from its draft; this
-- one has no draft to derive it from, and the sender needs a recipient.
ALTER TABLE "delivery_jobs" ADD COLUMN "conversation_id" TEXT;

ALTER TABLE "delivery_jobs"
  ADD CONSTRAINT "delivery_jobs_conversation_fkey"
  FOREIGN KEY ("workspace_id", "business_profile_id", "conversation_id") REFERENCES "conversations"("workspace_id", "business_profile_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Present exactly when there is no draft to ask. Requiring it on every row would duplicate a fact the
-- draft already carries, and two copies of one fact eventually disagree.
ALTER TABLE "delivery_jobs" ADD CONSTRAINT "delivery_jobs_conversation_origin_check" CHECK (
  ("human_text" IS NOT NULL) = ("conversation_id" IS NOT NULL)
);

