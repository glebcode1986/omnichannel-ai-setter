-- A searchable record of the material things people do (LEADS_ANALYTICS_UX.md, Issue #34).
--
-- One table, not nine. The spec asks for a *searchable* audit across channel connections, policy, mode,
-- knowledge, style, review decisions, takeover, template autopilot and membership. Nine tables cannot be
-- searched together without a union that grows every time somebody adds a tenth, so the kind is a column.
--
-- `policy_change_audits` stays exactly as it is. It holds the typed before/after of a policy edit, which is
-- richer than anything a general log should try to store; an audit event for a policy change points at that
-- row by id rather than copying it. One truth, one pointer, and no chance of the two disagreeing.

-- What kind of material action this was. Every value is something a person did that changes what the
-- product will do to a customer, or who can make it do so.
CREATE TYPE "AuditEventKind" AS ENUM (
  'CHANNEL_CONNECTED',
  'CHANNEL_DISCONNECTED',
  'POLICY_CHANGED',
  'MODE_CHANGED',
  'KNOWLEDGE_VERSIONED',
  'STYLE_VERSIONED',
  'DRAFT_APPROVED',
  'DRAFT_EDITED',
  'DRAFT_REJECTED',
  'REPLY_COMPOSED',
  'TAKEOVER_STARTED',
  'TAKEOVER_ENDED',
  'TEMPLATE_POLICY_CHANGED',
  'AMBIGUOUS_SEND_RESOLVED',
  'MEMBER_CHANGED'
);

-- Who acted. A person for almost everything here, but reconciliation and the scheduler resolve ambiguity
-- and cancel sends without anybody asking, and recording those as somebody's action would be a lie.
CREATE TYPE "AuditActorKind" AS ENUM ('USER', 'SYSTEM');

CREATE TABLE "audit_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" TEXT NOT NULL,
  -- NULL for a workspace-level action: a membership or role change belongs to nobody's Business Profile,
  -- and filing it under one would hide it from the workspace view where it actually matters.
  "business_profile_id" TEXT,
  "kind" "AuditEventKind" NOT NULL,
  "actor_kind" "AuditActorKind" NOT NULL,
  -- Set exactly when `actor_kind` is USER. A CHECK holds both halves.
  "actor_user_id" TEXT,
  "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- What the action was about, in words, for the search box. Written by the caller rather than rendered
  -- from `detail`, because the person searching remembers what they did and not our JSON shape.
  "summary" TEXT NOT NULL,
  -- The thing acted on: a table name and its id, so a row can be traced back without nine nullable
  -- foreign keys. Deliberately not a foreign key: an audit row must outlive what it describes.
  "subject_type" TEXT NOT NULL,
  "subject_id" TEXT NOT NULL,
  -- Filters the spec asks for. Denormalized on purpose: an audit search must not join the customer data
  -- it is auditing, or a deleted conversation takes its own history with it.
  "channel_account_id" TEXT,
  "conversation_id" TEXT,
  -- Whether reading this row needs an admin. Membership, roles and channel credentials are set here;
  -- everything an Agent does in the course of their own work is not.
  "sensitive" BOOLEAN NOT NULL DEFAULT FALSE,
  "detail" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- An actor is named exactly when there is one to name.
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_check" CHECK (
  ("actor_kind" = 'USER' AND "actor_user_id" IS NOT NULL)
  OR ("actor_kind" = 'SYSTEM' AND "actor_user_id" IS NULL)
);

-- An audit row with nothing written on it is worse than no row: it appears in a search as a thing that
-- happened and tells the reader nothing.
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_summary_check" CHECK (btrim("summary") <> '');
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_subject_check" CHECK (
  btrim("subject_type") <> '' AND btrim("subject_id") <> ''
);

-- Membership and channel connections are the two kinds that are always sensitive, whoever writes them.
-- Left as a CHECK rather than a default so a caller cannot quietly file a role change as ordinary work.
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_sensitivity_check" CHECK (
  "kind" NOT IN ('MEMBER_CHANGED', 'CHANNEL_CONNECTED', 'CHANNEL_DISCONNECTED') OR "sensitive" = TRUE
);

-- A Business Profile scoped kind must name its profile, and a membership change must not: the one is
-- customer-facing configuration, the other is who may configure it.
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_scope_check" CHECK (
  ("kind" = 'MEMBER_CHANGED' AND "business_profile_id" IS NULL)
  OR ("kind" <> 'MEMBER_CHANGED' AND "business_profile_id" IS NOT NULL)
);

ALTER TABLE "audit_events"
  ADD CONSTRAINT "audit_events_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "audit_events"
  ADD CONSTRAINT "audit_events_business_profile_fkey"
  FOREIGN KEY ("workspace_id", "business_profile_id") REFERENCES "business_profiles"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "audit_events"
  ADD CONSTRAINT "audit_events_actor_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- The history read: one workspace, newest first.
CREATE INDEX "audit_events_history_idx" ON "audit_events" ("workspace_id", "occurred_at" DESC);
-- The filtered reads the spec names: by profile, by kind, by channel account, by conversation.
CREATE INDEX "audit_events_profile_idx" ON "audit_events" ("workspace_id", "business_profile_id", "occurred_at" DESC);
CREATE INDEX "audit_events_kind_idx" ON "audit_events" ("workspace_id", "kind", "occurred_at" DESC);
CREATE INDEX "audit_events_channel_idx" ON "audit_events" ("workspace_id", "channel_account_id", "occurred_at" DESC);
CREATE INDEX "audit_events_conversation_idx" ON "audit_events" ("workspace_id", "conversation_id", "occurred_at" DESC);
-- Search over the words somebody remembers typing.
CREATE INDEX "audit_events_summary_idx" ON "audit_events" USING GIN (to_tsvector('simple', "summary"));

-- Append-only, and not by convention.
--
-- "Audit rows are not silently editable" is the task's own invariant, and a comment asking people to be
-- careful is not a mechanism. A trigger is the only thing that can express it: a CHECK cannot see that a
-- row already existed, and application code cannot bind a psql session or a future migration.
--
-- Corrections are appended, never applied in place. That is what makes the log worth reading: a row says
-- what was recorded at the time, and a reader does not have to wonder whether somebody tidied it since.
CREATE OR REPLACE FUNCTION "audit_events_append_only"() RETURNS TRIGGER AS $$
BEGIN
  -- The default SQLSTATE (P0001) on purpose. A more specific one gets mapped by the client into a
  -- foreign-key or constraint error whose text does not include this message, and the reader of the
  -- failure then has no idea why their update was refused.
  RAISE EXCEPTION 'audit_events is append-only: % is not permitted (append a correcting row instead)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_events_no_update" BEFORE UPDATE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION "audit_events_append_only"();

CREATE TRIGGER "audit_events_no_delete" BEFORE DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION "audit_events_append_only"();
