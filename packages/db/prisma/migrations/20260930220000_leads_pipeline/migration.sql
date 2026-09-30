-- The lead workspace: display config, the CRM-lite fields, and an audited stage history
-- (LEADS_ANALYTICS_UX.md, Issue #33).
--
-- Three decisions this encodes.
--
-- **Display labels are separate from the stable internal IDs.** `LeadStage` stays an enum, because the
-- draft engine's own output schema returns one and the policy engine reads one — the internal vocabulary
-- is a contract with the model, not a UI preference. A workspace renames, reorders and hides stages
-- through `lead_stage_displays`; nothing it does there can change what a stage *means* to the engine.
-- Adding an entirely new stage would require the enum to stop being an enum, which is a different and
-- larger decision than this task carries.
--
-- **The lead is the conversation's.** `conversations.lead_stage` already exists, the AI's suggestion is
-- per draft and therefore per conversation, and the Inbox already shows a stage per row. Moving the lead
-- to the contact would give one customer several conflicting stages across their conversations, and would
-- change what `lead_stage` means to everything that already reads it.
--
-- **Who said so is recorded, for every value.** The invariant is that AI suggestions stay distinct from
-- human-confirmed ones, so the source is a column on every stage transition and every captured answer —
-- not a convention inside a JSON blob that the next writer can forget.

CREATE TYPE "LeadValueSource" AS ENUM ('AI_SUGGESTED', 'HUMAN_CONFIRMED', 'HUMAN_SET');

-- How one workspace shows one stage. A missing row means the product default, so a workspace that never
-- touched this needs no backfill and no seeding.
CREATE TABLE "lead_stage_displays" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" TEXT NOT NULL,
  "stage" "LeadStage" NOT NULL,
  "label" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  -- Hidden, not deleted: conversations already sitting in a hidden stage still have to be reachable, or
  -- reordering a board would strand leads nobody can see.
  "hidden" BOOLEAN NOT NULL DEFAULT FALSE,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "lead_stage_displays_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "lead_stage_displays"
  ADD CONSTRAINT "lead_stage_displays_workspace_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE UNIQUE INDEX "lead_stage_displays_stage_key" ON "lead_stage_displays" ("workspace_id", "stage");
CREATE UNIQUE INDEX "lead_stage_displays_position_key" ON "lead_stage_displays" ("workspace_id", "position");

-- A label an operator cannot read is not a label.
ALTER TABLE "lead_stage_displays" ADD CONSTRAINT "lead_stage_displays_label_check" CHECK (btrim("label") <> '');
ALTER TABLE "lead_stage_displays" ADD CONSTRAINT "lead_stage_displays_position_check" CHECK ("position" >= 0);

-- The CRM-lite fields, on the conversation the lead is.
ALTER TABLE "conversations"
  ADD COLUMN "assigned_user_id" TEXT,
  ADD COLUMN "lead_tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "lead_note" TEXT,
  ADD COLUMN "next_action" TEXT,
  ADD COLUMN "next_action_at" TIMESTAMP(3);

ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_assigned_user_fkey"
  FOREIGN KEY ("assigned_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "conversations" ADD CONSTRAINT "conversations_lead_tags_check" CHECK (
  NOT ('' = ANY("lead_tags"))
);

-- A date with no action is a reminder about nothing; an action with no date is a note. Both are fine on
-- their own, so this only forbids the empty string, which is neither.
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_next_action_check" CHECK (
  "next_action" IS NULL OR btrim("next_action") <> ''
);

-- Every stage change, with who caused it and on whose authority.
CREATE TABLE "lead_stage_transitions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" TEXT NOT NULL,
  "business_profile_id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  -- NULL for the first recorded transition: a lead's earlier history predates this table rather than
  -- starting from a stage nobody set.
  "from_stage" "LeadStage",
  "to_stage" "LeadStage" NOT NULL,
  "source" "LeadValueSource" NOT NULL,
  -- Set exactly when a person did it (CHECK): an AI suggestion has no actor to name, and a human change
  -- with nobody's name on it is unattributed rather than automatic.
  "actor_user_id" TEXT,
  "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "lead_stage_transitions_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "lead_stage_transitions"
  ADD CONSTRAINT "lead_stage_transitions_workspace_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "lead_stage_transitions"
  ADD CONSTRAINT "lead_stage_transitions_conversation_fkey"
  FOREIGN KEY ("workspace_id", "business_profile_id", "conversation_id") REFERENCES "conversations"("workspace_id", "business_profile_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "lead_stage_transitions"
  ADD CONSTRAINT "lead_stage_transitions_actor_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "lead_stage_transitions" ADD CONSTRAINT "lead_stage_transitions_actor_check" CHECK (
  ("source" = 'AI_SUGGESTED') = ("actor_user_id" IS NULL)
);

-- A transition that changed nothing is not a transition.
ALTER TABLE "lead_stage_transitions" ADD CONSTRAINT "lead_stage_transitions_moved_check" CHECK (
  "from_stage" IS NULL OR "from_stage" <> "to_stage"
);

CREATE INDEX "lead_stage_transitions_history_idx"
  ON "lead_stage_transitions" ("workspace_id", "business_profile_id", "conversation_id", "changed_at" DESC);

-- What the business learned about this lead, and who supplied each answer.
--
-- A row per criterion rather than a JSON blob, so "AI suggestions stay distinct from human-confirmed
-- values" is a column somebody would have to deliberately lie in, rather than a convention the next
-- writer can forget.
CREATE TABLE "lead_qualification_answers" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" TEXT NOT NULL,
  "business_profile_id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  -- The criterion as the Business Profile's policy words it, so an answer can be matched back to the
  -- question that was being asked at the time.
  "criterion" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "source" "LeadValueSource" NOT NULL,
  "actor_user_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "lead_qualification_answers_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "lead_qualification_answers"
  ADD CONSTRAINT "lead_qualification_answers_workspace_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "lead_qualification_answers"
  ADD CONSTRAINT "lead_qualification_answers_conversation_fkey"
  FOREIGN KEY ("workspace_id", "business_profile_id", "conversation_id") REFERENCES "conversations"("workspace_id", "business_profile_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "lead_qualification_answers"
  ADD CONSTRAINT "lead_qualification_answers_actor_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "lead_qualification_answers" ADD CONSTRAINT "lead_qualification_answers_actor_check" CHECK (
  ("source" = 'AI_SUGGESTED') = ("actor_user_id" IS NULL)
);

ALTER TABLE "lead_qualification_answers" ADD CONSTRAINT "lead_qualification_answers_text_check" CHECK (
  btrim("criterion") <> '' AND btrim("value") <> ''
);

-- One answer per criterion per source: the AI's reading and a person's confirmation coexist on purpose,
-- and the UI shows them side by side rather than one silently replacing the other.
CREATE UNIQUE INDEX "lead_qualification_answers_criterion_key"
  ON "lead_qualification_answers" ("workspace_id", "business_profile_id", "conversation_id", "criterion", "source");
