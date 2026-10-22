-- The internal control plane: staff identity, scoped support access and its own audit (#59,
-- ADMIN_OPERATIONS.md).
--
-- Three tables, and the first thing to say is why the audit is not `audit_events`. Two of the four
-- reasons make it impossible rather than merely awkward:
--
--   * `audit_events.workspace_id` is `NOT NULL` with a foreign key to `workspaces`
--     (20261001010000_audit_events/migration.sql), so an operator action that names no tenant — pulling
--     the global kill switch, granting a platform role — has no row shape at all;
--   * `audit_events_scope_check` is exact rather than permissive
--     (20261007210000_billing_routing/migration.sql, where it was last rewritten): its second disjunct
--     forces `business_profile_id IS NOT NULL` for any kind outside the workspace-scoped allowlist, so
--     every new operator kind would mean rewriting that constraint;
--   * `AuditEventKind` is a closed enum and contains no operator kind;
--   * and `searchAuditEvents` authorizes through a customer's own `WorkspaceContext` and gates
--     sensitivity on the *customer's* ADMIN role, so internal staff activity filed there would become
--     readable by the customer's owner — the exact inversion `ADMIN_OPERATIONS.md` forbids.
--
-- What this table does reuse, on purpose: the append-only trigger pattern with its deliberate P0001
-- SQLSTATE, writing the row in the same transaction as the change it describes, and `RESTRICT` on the
-- actor so attribution survives a departure.
--
-- Every foreign key here is `RESTRICT` on both delete and update, with no exceptions, which
-- `constraints.integration.test.ts` asserts exactly: it compares the full set of cascading constraints
-- against three names, so a fourth fails the suite whatever its intent. A session or an audit row that
-- cleaned itself up when a staff member left would also destroy the attributability the spec requires.
-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('SUPPORT', 'BILLING', 'OPERATIONS', 'PLATFORM_ADMIN');

-- CreateEnum
CREATE TYPE "PlatformAuditSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "PlatformAuditKind" AS ENUM ('PLATFORM_MEMBER_CHANGED', 'WORKSPACE_INSPECTED', 'SUPPORT_SESSION_OPENED', 'SUPPORT_SESSION_REVOKED', 'BREAK_GLASS_OPENED', 'CUSTOMER_CONTENT_READ', 'KILL_SWITCH_PULLED', 'KILL_SWITCH_LIFTED', 'RECONCILIATION_REQUESTED');

-- CreateTable
CREATE TABLE "platform_members" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "PlatformRole" NOT NULL,
    "note" TEXT NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_access_sessions" (
    "id" TEXT NOT NULL,
    "platform_member_id" TEXT NOT NULL,
    "actor_role" "PlatformRole" NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "business_profile_id" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reason" TEXT NOT NULL,
    "ticket_ref" TEXT,
    "break_glass" BOOLEAN NOT NULL DEFAULT false,
    "started_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_by_member_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_access_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_audit_events" (
    "id" TEXT NOT NULL,
    "platform_member_id" TEXT NOT NULL,
    "actor_role" "PlatformRole" NOT NULL,
    "kind" "PlatformAuditKind" NOT NULL,
    "severity" "PlatformAuditSeverity" NOT NULL,
    "workspace_id" TEXT,
    "business_profile_id" TEXT,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "support_session_id" TEXT,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_members_user_id_key" ON "platform_members"("user_id");

-- CreateIndex
CREATE INDEX "platform_members_role_revoked_at_idx" ON "platform_members"("role", "revoked_at");

-- CreateIndex
CREATE INDEX "support_access_sessions_platform_member_id_expires_at_idx" ON "support_access_sessions"("platform_member_id", "expires_at");

-- CreateIndex
CREATE INDEX "support_access_sessions_workspace_id_expires_at_idx" ON "support_access_sessions"("workspace_id", "expires_at");

-- CreateIndex
CREATE INDEX "platform_audit_events_occurred_at_idx" ON "platform_audit_events"("occurred_at");

-- CreateIndex
CREATE INDEX "platform_audit_events_severity_occurred_at_idx" ON "platform_audit_events"("severity", "occurred_at");

-- CreateIndex
CREATE INDEX "platform_audit_events_workspace_id_occurred_at_idx" ON "platform_audit_events"("workspace_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "platform_members" ADD CONSTRAINT "platform_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "support_access_sessions" ADD CONSTRAINT "support_access_sessions_platform_member_id_fkey" FOREIGN KEY ("platform_member_id") REFERENCES "platform_members"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "support_access_sessions" ADD CONSTRAINT "support_access_sessions_revoked_by_member_id_fkey" FOREIGN KEY ("revoked_by_member_id") REFERENCES "platform_members"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "support_access_sessions" ADD CONSTRAINT "support_access_sessions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "support_access_sessions" ADD CONSTRAINT "support_access_sessions_workspace_id_business_profile_id_fkey" FOREIGN KEY ("workspace_id", "business_profile_id") REFERENCES "business_profiles"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "platform_audit_events" ADD CONSTRAINT "platform_audit_events_platform_member_id_fkey" FOREIGN KEY ("platform_member_id") REFERENCES "platform_members"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "platform_audit_events" ADD CONSTRAINT "platform_audit_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "platform_audit_events" ADD CONSTRAINT "platform_audit_events_workspace_id_business_profile_id_fkey" FOREIGN KEY ("workspace_id", "business_profile_id") REFERENCES "business_profiles"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;



-- ---------------------------------------------------------------------------------------------------------
-- Invariants Prisma cannot express (#59)
-- ---------------------------------------------------------------------------------------------------------

-- A role nobody can explain is a role nobody dares remove, and a withdrawal that predates the grant is
-- not a withdrawal.
ALTER TABLE "platform_members" ADD CONSTRAINT "platform_members_shape_check" CHECK (
  btrim("note") <> '' AND ("revoked_at" IS NULL OR "revoked_at" >= "created_at")
);

/*
  A support session's clock, enforced on the row.

  The fifteen-minute break-glass ceiling is here rather than in the caller because a maximum a caller
  could widen is not a maximum — and break-glass is exactly the path somebody reaches for in a hurry. The
  eight-hour ordinary ceiling is the same argument with a longer number: a working session, not a
  standing grant.

  `scopes` is non-empty and contains no metadata scope. Metadata is what an operator sees *without* a
  session, so a session granting it would grant nothing while appearing to grant something — which is
  worse than no session at all.
*/
ALTER TABLE "support_access_sessions" ADD CONSTRAINT "support_access_sessions_clock_check" CHECK (
  "expires_at" > "started_at"
  AND ("revoked_at" IS NULL OR "revoked_at" >= "started_at")
  AND (NOT "break_glass" OR "expires_at" <= "started_at" + INTERVAL '15 minutes')
  AND ("break_glass" OR "expires_at" <= "started_at" + INTERVAL '8 hours')
);

ALTER TABLE "support_access_sessions" ADD CONSTRAINT "support_access_sessions_scope_check" CHECK (
  array_length("scopes", 1) >= 1
  AND "scopes" <@ ARRAY['CONVERSATION_CONTENT', 'BILLING_DETAIL']::TEXT[]
  AND btrim("reason") <> ''
);

-- A revocation names who performed it, or neither fact is recorded. The customer audit's lift CHECK makes
-- the same pairing for the same reason: half a record is worse than none, because it reads as complete.
ALTER TABLE "support_access_sessions" ADD CONSTRAINT "support_access_sessions_revocation_check" CHECK (
  ("revoked_at" IS NULL) = ("revoked_by_member_id" IS NULL)
);

-- An internal action without a stated reason is the thing this table exists to make impossible, and a
-- subject nobody can name is a row nobody can act on.
ALTER TABLE "platform_audit_events" ADD CONSTRAINT "platform_audit_events_shape_check" CHECK (
  btrim("reason") <> '' AND btrim("subject_type") <> '' AND btrim("subject_id") <> ''
);

/*
  Severity is paired with the kind, in the database as well as in the domain.

  `platformAuditSeverity` derives it and no caller may choose — which is the customer audit's rule for
  `sensitive`, and it matters more here because the row this would get wrong is the one an incident review
  reads first. Spelled out rather than trusted, because a support script writing a row by hand is exactly
  the case where the derivation is not running.

  The two CRITICAL kinds are the two acts that are indistinguishable from an attack if nobody authorised
  them: breaking the glass, and reading a customer's correspondence.
*/
ALTER TABLE "platform_audit_events" ADD CONSTRAINT "platform_audit_events_severity_check" CHECK (
  ("kind" IN ('BREAK_GLASS_OPENED', 'CUSTOMER_CONTENT_READ') AND "severity" = 'CRITICAL')
  OR ("kind" IN ('PLATFORM_MEMBER_CHANGED', 'SUPPORT_SESSION_OPENED', 'KILL_SWITCH_PULLED', 'KILL_SWITCH_LIFTED') AND "severity" = 'WARNING')
  OR ("kind" IN ('WORKSPACE_INSPECTED', 'SUPPORT_SESSION_REVOKED', 'RECONCILIATION_REQUESTED') AND "severity" = 'INFO')
);

-- Reading a customer's correspondence is recorded with the session that permitted it. Without that link
-- the row says somebody read a thread and cannot say under what authority, which is most of what the
-- record is for.
ALTER TABLE "platform_audit_events" ADD CONSTRAINT "platform_audit_events_session_check" CHECK (
  "kind" <> 'CUSTOMER_CONTENT_READ' OR "support_session_id" IS NOT NULL
);

-- Append-only. An internal audit somebody could edit is not one.
CREATE OR REPLACE FUNCTION "platform_audit_events_append_only"() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'platform_audit_events are append-only: the record of an operator action is not edited or removed';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "platform_audit_events_no_change"
    BEFORE UPDATE OR DELETE ON "platform_audit_events"
    FOR EACH ROW EXECUTE FUNCTION "platform_audit_events_append_only"();

-- A session is append-mostly: it may be revoked, and nothing else about it may change. Widening the scope
-- or pushing the expiry of a session already granted would turn a fifteen-minute grant into a standing one
-- without a second authorisation.
CREATE OR REPLACE FUNCTION "support_access_sessions_immutable"() RETURNS TRIGGER AS $$
BEGIN
    IF NEW."platform_member_id" IS DISTINCT FROM OLD."platform_member_id"
       OR NEW."actor_role" IS DISTINCT FROM OLD."actor_role"
       OR NEW."workspace_id" IS DISTINCT FROM OLD."workspace_id"
       OR NEW."business_profile_id" IS DISTINCT FROM OLD."business_profile_id"
       OR NEW."scopes" IS DISTINCT FROM OLD."scopes"
       OR NEW."reason" IS DISTINCT FROM OLD."reason"
       OR NEW."ticket_ref" IS DISTINCT FROM OLD."ticket_ref"
       OR NEW."break_glass" IS DISTINCT FROM OLD."break_glass"
       OR NEW."started_at" IS DISTINCT FROM OLD."started_at"
       OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
        RAISE EXCEPTION 'a support access session is not widened or extended; open a new one';
    END IF;
    IF OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at" THEN
        RAISE EXCEPTION 'a support access session was already revoked';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "support_access_sessions_no_change"
    BEFORE UPDATE ON "support_access_sessions"
    FOR EACH ROW EXECUTE FUNCTION "support_access_sessions_immutable"();

CREATE OR REPLACE FUNCTION "support_access_sessions_no_delete_fn"() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'support_access_sessions are never deleted: an audit row names them';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "support_access_sessions_no_delete"
    BEFORE DELETE ON "support_access_sessions"
    FOR EACH ROW EXECUTE FUNCTION "support_access_sessions_no_delete_fn"();

/*
  An operator pause names the operator.

  Load-bearing, not tidiness. `activeSystemSuspension` identifies the system's own switch precisely by
  `by_user_id IS NULL` (packages/db/src/suspension-store.ts), and every write it makes is restricted the
  same way so that an automatic guard can never extend, shorten or end a switch a person pulled. An
  operator pause inserted with no actor is therefore indistinguishable from a system pause — and the
  backlog guard would be free to close it, which is the one thing it must never do.
--
  `ADMIN_OPERATIONS.md` also requires an actor and a reason on every kill-switch change; this is the half a
  constraint can state. A `note` is still optional for the system's own switch, which has nothing to add
  beyond its reason.
*/
ALTER TABLE "automation_suspensions" ADD CONSTRAINT "automation_suspensions_operator_check" CHECK (
  "reason" <> 'OPERATOR' OR "by_user_id" IS NOT NULL
);
