-- Conversation goals, follow-ups and human tasks (GOALS_FOLLOWUPS.md, Issue #55).
--
-- The issue's own framing is the design brief: "bounded goal execution and follow-up automation without
-- turning the product into an unlimited outreach engine." Everything below is arranged so that the
-- unlimited version cannot be built by accident.
--
-- Three tables, and the separations between them are the point:
--
--   * a **goal** is what a conversation is for. It carries no schedule, so it cannot chase anybody.
--   * a **follow-up** is one scheduled attempt. It carries an anchor, a bounded attempt count and a stop
--     reason, and it does not carry a message — it asks the shared coordinator for one at execution time,
--     which is what keeps every send on the one path that already has the gates.
--   * a **human task** is work for a person. It has no draft, no operation and no delivery relation at
--     all, which is how "completing a task never sends a customer a message" holds without anybody
--     remembering it.
--
-- `NextAction` is deliberately absent: `conversations.next_action` and `next_action_at` already exist from
-- the leads work, and a lead's "what happens next" and a conversation's are the same question. A second
-- place to answer it would give two answers.

CREATE TYPE "ConversationGoalKind" AS ENUM (
  'ANSWER_QUESTION',
  'BOOK_APPOINTMENT',
  'QUALIFY_LEAD',
  'COLLECT_DETAILS',
  'CONFIRM_ATTENDANCE',
  'RESOLVE_COMPLAINT',
  -- Explicitly nothing further. A conversation with this goal may not have a follow-up scheduled at all.
  'NONE'
);

CREATE TYPE "GoalStatus" AS ENUM ('ACTIVE', 'ACHIEVED', 'ABANDONED');

-- Who decided. A model may propose a goal; only a person makes it the conversation's own, and the row says
-- which — the same rule the customer-memory work established for facts.
CREATE TYPE "GoalSource" AS ENUM ('AI_SUGGESTED', 'HUMAN_SET');

CREATE TYPE "FollowUpStatus" AS ENUM ('PENDING', 'SENT', 'BLOCKED', 'CANCELLED', 'SUPERSEDED', 'EXHAUSTED');

-- Why a follow-up stopped. Closed, so "why was this customer not chased" has an answer rather than a shrug.
CREATE TYPE "FollowUpStopReason" AS ENUM (
  'NEW_INBOUND',
  'HUMAN_TAKEOVER',
  'REVIEW_PENDING',
  'OPTED_OUT',
  'ENTITLEMENT_LOST',
  'CHANNEL_INELIGIBLE',
  'GOAL_TERMINAL',
  'STALE_ANCHOR',
  'MAX_ATTEMPTS',
  'HUMAN_CANCELLED',
  'SUPERSEDED_BY_NEWER',
  'CONVERSATION_CLOSED'
);

CREATE TYPE "HumanTaskStatus" AS ENUM ('OPEN', 'DONE', 'DISMISSED');

CREATE TYPE "HumanTaskKind" AS ENUM (
  'CALL_CUSTOMER',
  'CHECK_AVAILABILITY',
  'PREPARE_QUOTE',
  'VERIFY_DETAILS',
  'ESCALATE_INTERNALLY',
  'REVIEW_CONVERSATION',
  'OTHER'
);

-- ---------------------------------------------------------------------------------------------------------
-- Goals
-- ---------------------------------------------------------------------------------------------------------

CREATE TABLE "conversation_goals" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" TEXT NOT NULL,
  "business_profile_id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "kind" "ConversationGoalKind" NOT NULL,
  -- The primary goal is what the conversation is for; a secondary is a nice-to-have alongside it. One
  -- primary at a time, which a partial unique index enforces: two primary goals is two answers to "what
  -- are we trying to do here", and the assistant would have to pick one at random.
  "is_primary" BOOLEAN NOT NULL,
  "status" "GoalStatus" NOT NULL DEFAULT 'ACTIVE',
  "source" "GoalSource" NOT NULL,
  -- Set exactly when a person decided. A model's proposal has nobody's name on it until somebody confirms.
  "set_by_user_id" TEXT,
  -- The draft a model's proposal came from, so an operator can read the reply that produced it.
  "source_draft_id" TEXT,
  "note" TEXT,
  "achieved_at" TIMESTAMP(3),
  "abandoned_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "conversation_goals_pkey" PRIMARY KEY ("id")
);

-- A person's goal names the person; a model's names the draft. Neither may be anonymous.
ALTER TABLE "conversation_goals" ADD CONSTRAINT "conversation_goals_provenance_check" CHECK (
  ("source" = 'HUMAN_SET' AND "set_by_user_id" IS NOT NULL)
  OR ("source" = 'AI_SUGGESTED' AND "source_draft_id" IS NOT NULL)
);

-- A terminal status has a moment, and a moment means it is terminal. Half of that pair is a row nobody
-- can read, and the timestamps are what the analytics count.
ALTER TABLE "conversation_goals" ADD CONSTRAINT "conversation_goals_terminal_check" CHECK (
  ("status" = 'ACTIVE' AND "achieved_at" IS NULL AND "abandoned_at" IS NULL)
  OR ("status" = 'ACHIEVED' AND "achieved_at" IS NOT NULL AND "abandoned_at" IS NULL)
  OR ("status" = 'ABANDONED' AND "abandoned_at" IS NOT NULL AND "achieved_at" IS NULL)
);

-- NONE means "nothing further", which is not a thing that can be achieved. Allowing it would let a
-- follow-up be justified by a goal that says there is nothing to follow up about.
ALTER TABLE "conversation_goals" ADD CONSTRAINT "conversation_goals_none_check" CHECK (
  "kind" <> 'NONE' OR ("is_primary" AND "status" <> 'ACHIEVED')
);

ALTER TABLE "conversation_goals"
  ADD CONSTRAINT "conversation_goals_conversation_fkey"
  FOREIGN KEY ("workspace_id", "business_profile_id", "conversation_id") REFERENCES "conversations"("workspace_id", "business_profile_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "conversation_goals"
  ADD CONSTRAINT "conversation_goals_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "conversation_goals"
  ADD CONSTRAINT "conversation_goals_actor_fkey"
  FOREIGN KEY ("set_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "conversation_goals"
  ADD CONSTRAINT "conversation_goals_draft_fkey"
  FOREIGN KEY ("workspace_id", "business_profile_id", "source_draft_id") REFERENCES "ai_drafts"("workspace_id", "business_profile_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- One active primary goal per conversation.
CREATE UNIQUE INDEX "conversation_goals_active_primary_key"
  ON "conversation_goals" ("workspace_id", "business_profile_id", "conversation_id")
  WHERE "status" = 'ACTIVE' AND "is_primary";

CREATE INDEX "conversation_goals_history_idx"
  ON "conversation_goals" ("workspace_id", "business_profile_id", "conversation_id", "created_at" DESC);

-- ---------------------------------------------------------------------------------------------------------
-- Follow-ups
-- ---------------------------------------------------------------------------------------------------------

CREATE TABLE "follow_ups" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" TEXT NOT NULL,
  "business_profile_id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  -- The goal this follow-up serves. Required: a follow-up with no goal is chasing somebody for no stated
  -- reason, which is the outreach engine this task exists to not build.
  "goal_id" UUID NOT NULL,
  "status" "FollowUpStatus" NOT NULL DEFAULT 'PENDING',
  "due_at" TIMESTAMP(3) NOT NULL,
  -- The state this follow-up was planned against. Revalidated at execution: if the conversation has moved
  -- past this anchor, the follow-up answers a question that has changed.
  "anchor_message_id" TEXT NOT NULL,
  "anchor_state_version" INTEGER NOT NULL,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  -- Bounded, and bounded in the database. "No unlimited chasing" is the issue's wording; this is where it
  -- stops being a hope. Five is the hard ceiling: past that the difference between following up and
  -- harassing somebody is a matter of opinion, and this product does not get to hold the opinion.
  "max_attempts" INTEGER NOT NULL DEFAULT 3,
  -- The profile's own sending window, in its own timezone. Follow-ups are scheduled in the *business's*
  -- daypart, not the server's: when a business is willing to message people is its decision.
  "daypart_time_zone" TEXT NOT NULL,
  "daypart_start_hour" INTEGER NOT NULL,
  "daypart_end_hour" INTEGER NOT NULL,
  "stop_reason" "FollowUpStopReason",
  "created_by_user_id" TEXT,
  -- Set when an attempt reached the coordinator, so the follow-up and the send it caused can be joined.
  "delivery_operation_id" TEXT,
  "last_attempt_at" TIMESTAMP(3),
  "settled_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "follow_ups_pkey" PRIMARY KEY ("id")
);

-- Attempts are bounded, and the bound is sane. A row claiming twelve attempts would be a row somebody
-- wrote to get around the ceiling.
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_attempts_check" CHECK (
  "max_attempts" BETWEEN 1 AND 5 AND "attempt_count" >= 0 AND "attempt_count" <= "max_attempts"
);

-- A pending follow-up has not stopped, and a stopped one says why and when. Without both halves the log
-- reads as "we chose not to message this customer" with no reason attached.
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_settlement_check" CHECK (
  ("status" = 'PENDING' AND "stop_reason" IS NULL AND "settled_at" IS NULL)
  OR ("status" = 'SENT' AND "stop_reason" IS NULL AND "settled_at" IS NOT NULL AND "delivery_operation_id" IS NOT NULL)
  OR ("status" IN ('BLOCKED', 'CANCELLED', 'SUPERSEDED', 'EXHAUSTED') AND "stop_reason" IS NOT NULL AND "settled_at" IS NOT NULL)
);

-- `EXHAUSTED` is the one status that means the ceiling was reached, and it may not claim any other reason.
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_exhausted_check" CHECK (
  ("status" <> 'EXHAUSTED' OR "stop_reason" = 'MAX_ATTEMPTS')
  AND ("stop_reason" IS DISTINCT FROM 'MAX_ATTEMPTS' OR "status" = 'EXHAUSTED')
);

-- A half-open window, and never zero-width. A window of 9 to 9 would be a misconfiguration that either
-- sends nothing or sends around the clock depending on how it is read, and the second is unforgivable.
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_daypart_check" CHECK (
  "daypart_start_hour" BETWEEN 0 AND 23
  AND "daypart_end_hour" BETWEEN 0 AND 23
  AND "daypart_start_hour" <> "daypart_end_hour"
  AND btrim("daypart_time_zone") <> ''
);

ALTER TABLE "follow_ups"
  ADD CONSTRAINT "follow_ups_conversation_fkey"
  FOREIGN KEY ("workspace_id", "business_profile_id", "conversation_id") REFERENCES "conversations"("workspace_id", "business_profile_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "follow_ups"
  ADD CONSTRAINT "follow_ups_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "follow_ups"
  ADD CONSTRAINT "follow_ups_goal_fkey"
  FOREIGN KEY ("goal_id") REFERENCES "conversation_goals"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "follow_ups"
  ADD CONSTRAINT "follow_ups_anchor_fkey"
  FOREIGN KEY ("workspace_id", "business_profile_id", "anchor_message_id") REFERENCES "messages"("workspace_id", "business_profile_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "follow_ups"
  ADD CONSTRAINT "follow_ups_creator_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- One pending follow-up per conversation.
--
-- This is the duplicate-job guard, and it is an index rather than a check in code because the race it
-- prevents is two workers planning a follow-up at the same moment. Whichever commits second is refused by
-- the database, which is the only place that can see both.
CREATE UNIQUE INDEX "follow_ups_pending_conversation_key"
  ON "follow_ups" ("workspace_id", "business_profile_id", "conversation_id")
  WHERE "status" = 'PENDING';

-- The due-work scan.
CREATE INDEX "follow_ups_due_idx" ON "follow_ups" ("status", "due_at");
CREATE INDEX "follow_ups_profile_idx" ON "follow_ups" ("workspace_id", "business_profile_id", "status", "due_at");

-- ---------------------------------------------------------------------------------------------------------
-- Human tasks
-- ---------------------------------------------------------------------------------------------------------

-- Work for a person.
--
-- Note what this table does not have: no draft, no operation id, no delivery reference, no message text,
-- no relation to anything that sends. That is not an omission to be filled in later — it is the mechanism
-- by which "completion or dismissal of a HumanTask never sends a customer message" holds. There is nothing
-- here for a send path to attach to, so no amount of careless code can make marking a task done deliver
-- anything to anybody.
CREATE TABLE "human_tasks" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" TEXT NOT NULL,
  "business_profile_id" TEXT NOT NULL,
  -- Optional: a task can be about a conversation or about the business generally.
  "conversation_id" TEXT,
  "kind" "HumanTaskKind" NOT NULL,
  "status" "HumanTaskStatus" NOT NULL DEFAULT 'OPEN',
  "title" TEXT NOT NULL,
  "detail" TEXT,
  "due_at" TIMESTAMP(3),
  "assigned_user_id" TEXT,
  "created_by_user_id" TEXT,
  -- A model may raise a task; that is safe precisely because a task cannot send anything.
  "source_draft_id" TEXT,
  "completed_by_user_id" TEXT,
  "completed_at" TIMESTAMP(3),
  "dismissed_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "human_tasks_pkey" PRIMARY KEY ("id")
);

-- A task somebody finished names them and the moment; an open one names neither.
ALTER TABLE "human_tasks" ADD CONSTRAINT "human_tasks_completion_check" CHECK (
  ("status" = 'OPEN' AND "completed_by_user_id" IS NULL AND "completed_at" IS NULL AND "dismissed_reason" IS NULL)
  OR ("status" = 'DONE' AND "completed_by_user_id" IS NOT NULL AND "completed_at" IS NOT NULL AND "dismissed_reason" IS NULL)
  OR ("status" = 'DISMISSED' AND "completed_by_user_id" IS NOT NULL AND "completed_at" IS NOT NULL)
);

ALTER TABLE "human_tasks" ADD CONSTRAINT "human_tasks_title_check" CHECK (btrim("title") <> '');

ALTER TABLE "human_tasks"
  ADD CONSTRAINT "human_tasks_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "human_tasks"
  ADD CONSTRAINT "human_tasks_business_profile_fkey"
  FOREIGN KEY ("workspace_id", "business_profile_id") REFERENCES "business_profiles"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "human_tasks"
  ADD CONSTRAINT "human_tasks_conversation_fkey"
  FOREIGN KEY ("workspace_id", "business_profile_id", "conversation_id") REFERENCES "conversations"("workspace_id", "business_profile_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "human_tasks"
  ADD CONSTRAINT "human_tasks_assignee_fkey"
  FOREIGN KEY ("assigned_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "human_tasks"
  ADD CONSTRAINT "human_tasks_creator_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "human_tasks"
  ADD CONSTRAINT "human_tasks_completer_fkey"
  FOREIGN KEY ("completed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "human_tasks"
  ADD CONSTRAINT "human_tasks_draft_fkey"
  FOREIGN KEY ("workspace_id", "business_profile_id", "source_draft_id") REFERENCES "ai_drafts"("workspace_id", "business_profile_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX "human_tasks_queue_idx"
  ON "human_tasks" ("workspace_id", "business_profile_id", "status", "due_at");

CREATE INDEX "human_tasks_assignee_idx"
  ON "human_tasks" ("workspace_id", "business_profile_id", "assigned_user_id", "status");

-- ---------------------------------------------------------------------------------------------------------
-- Customer suppression
-- ---------------------------------------------------------------------------------------------------------

-- A customer who asked not to be chased.
--
-- Its own table rather than a column on `contacts`, because it is a claim with provenance: who recorded it,
-- when, and on what evidence. A boolean on the contact would answer "may we message them" without ever
-- answering "who decided that", and an opt-out somebody cannot account for is one they cannot defend.
--
-- Scoped to the Business Profile, like every other customer fact: a person who opted out of one business's
-- follow-ups has said nothing about another's.
CREATE TABLE "followup_suppressions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" TEXT NOT NULL,
  "business_profile_id" TEXT NOT NULL,
  "contact_id" TEXT NOT NULL,
  -- Free text on purpose: this is the evidence, in the words of whoever recorded it.
  "reason" TEXT NOT NULL,
  "recorded_by_user_id" TEXT,
  "source_message_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lifted_at" TIMESTAMP(3),
  "lifted_by_user_id" TEXT,

  CONSTRAINT "followup_suppressions_pkey" PRIMARY KEY ("id")
);

-- Lifting an opt-out is a person's decision, and the row names them. Nothing automatic may lift one:
-- a suppression that expired on its own would start messaging somebody who asked us to stop.
ALTER TABLE "followup_suppressions" ADD CONSTRAINT "followup_suppressions_lift_check" CHECK (
  ("lifted_at" IS NULL AND "lifted_by_user_id" IS NULL)
  OR ("lifted_at" IS NOT NULL AND "lifted_by_user_id" IS NOT NULL)
);

ALTER TABLE "followup_suppressions" ADD CONSTRAINT "followup_suppressions_reason_check" CHECK (btrim("reason") <> '');

ALTER TABLE "followup_suppressions"
  ADD CONSTRAINT "followup_suppressions_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "followup_suppressions"
  ADD CONSTRAINT "followup_suppressions_contact_fkey"
  FOREIGN KEY ("workspace_id", "business_profile_id", "contact_id") REFERENCES "contacts"("workspace_id", "business_profile_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "followup_suppressions"
  ADD CONSTRAINT "followup_suppressions_recorder_fkey"
  FOREIGN KEY ("recorded_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "followup_suppressions"
  ADD CONSTRAINT "followup_suppressions_lifter_fkey"
  FOREIGN KEY ("lifted_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "followup_suppressions"
  ADD CONSTRAINT "followup_suppressions_message_fkey"
  FOREIGN KEY ("workspace_id", "business_profile_id", "source_message_id") REFERENCES "messages"("workspace_id", "business_profile_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- One live suppression per customer per profile, so "are they opted out" is one row and not a count.
CREATE UNIQUE INDEX "followup_suppressions_live_key"
  ON "followup_suppressions" ("workspace_id", "business_profile_id", "contact_id")
  WHERE "lifted_at" IS NULL;
