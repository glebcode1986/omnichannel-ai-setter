/**
 * The internal control plane, against a real database (#59, ADMIN_OPERATIONS.md).
 *
 * Issue #59 names its own test list — internal-role authorization, metadata-only support access, an
 * expired session, break-glass audit, kill-switch behaviour, cross-workspace non-disclosure, entitlement
 * override expiry and admin action idempotency — and most of those are only meaningful as *pairs*: a test
 * that a metadata read works proves nothing unless the content read is refused beside it.
 *
 * Two of these are the ones worth having above all others:
 *
 * - a `PlatformContext` is refused by `scopeOf`, `profileScopeOf` and `requireRole`, so an operator's
 *   authority can never be mistaken for a member's;
 * - opening a workspace's usage panel writes nothing into that tenant, which `readUsage` would have done
 *   on the first page load because opening a cycle creates it.
 */
import {
  BREAK_GLASS_MAX_MS,
  PLATFORM_PERMISSION_MATRIX,
  PLATFORM_PERMISSIONS,
  PLATFORM_ROLES,
  platformAuditSeverity,
  type PlatformRole,
} from "@omnichannel/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { connectChannelAccount } from "./repositories/channel-accounts";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import type { DbClient, DbExecutor } from "./client";
import { createTestUser, seedWorkspace } from "./testing/fixtures";
import { DbInputError, PlatformAccessDeniedError, PlatformPermissionError, WorkspaceAccessDeniedError } from "./errors";
import { liftKillSwitch, listKillSwitches, pullKillSwitch, requestReconciliation } from "./platform-actions-store";
import { recordPlatformAuditEvent, searchPlatformAuditEvents } from "./platform-audit-store";
import { findWorkspaces, listReconciliations, readConversationContent, readSupportSnapshot } from "./platform-read-store";
import { authorizePlatformAccess, platformActorOf, requirePlatformPermission, type PlatformContext } from "./platform-tenancy";
import { listSupportSessions, openSupportAccessSession, readSupportScope, revokeSupportAccessSession, setPlatformMember } from "./support-access-store";
import { profileScopeOf, requireRole, scopeOf } from "./tenancy";

const NOW = new Date("2026-10-08T12:00:00.000Z");

describe.skipIf(!databaseTestsEnabled())("the internal control plane (PostgreSQL)", () => {
  let database: TestDatabase;
  let admin: PlatformContext;
  let support: PlatformContext;
  let operations: PlatformContext;
  let billing: PlatformContext;
  let tenant: Awaited<ReturnType<typeof seedWorkspace>>;
  let otherTenant: Awaited<ReturnType<typeof seedWorkspace>>;
  const db = () => database.db;

  /** A staff member with a role, created the way production would once one admin exists. */
  async function staff(label: string, role: PlatformRole): Promise<PlatformContext> {
    const userId = await createTestUser(db(), `platform-${label}`);
    await db().platformMember.create({ data: { userId, role, note: `${label} rota` } });
    return authorizePlatformAccess(db(), userId);
  }

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    tenant = await seedWorkspace(database.db, "platform-tenant");
    otherTenant = await seedWorkspace(database.db, "platform-other");
    admin = await staff("admin", "PLATFORM_ADMIN");
    support = await staff("support", "SUPPORT");
    operations = await staff("operations", "OPERATIONS");
    billing = await staff("billing", "BILLING");
  }, 180_000);

  afterAll(async () => {
    await database?.dispose();
  });

  describe("who an operator is", () => {
    it("refuses a user with no platform role, and one whose role was withdrawn", async () => {
      const outsider = await createTestUser(db(), "platform-outsider");
      await expect(authorizePlatformAccess(db(), outsider)).rejects.toThrow(PlatformAccessDeniedError);

      const leaver = await createTestUser(db(), "platform-leaver");
      // Both timestamps from the fixture clock, so the row is consistent with itself whatever the wall
      // clock says. `created_at` defaults to `now()`, and `platform_members_shape_check` requires a
      // revocation not to precede the creation — so pinning only `revokedAt` made this test depend on
      // real time being earlier than the constant. It passed for an afternoon and then did not.
      await db().platformMember.create({
        data: { userId: leaver, role: "SUPPORT", note: "left", createdAt: NOW, revokedAt: NOW },
      });
      // Identical refusal: a distinguishable one would tell somebody which user ids are staff.
      await expect(authorizePlatformAccess(db(), leaver)).rejects.toThrow(PlatformAccessDeniedError);
      await expect(authorizePlatformAccess(db(), "")).rejects.toThrow(PlatformAccessDeniedError);
    });

    it("refuses a platform context that was assembled rather than issued", async () => {
      const forged = { platformMemberId: "pm-1", userId: "u-1", role: "PLATFORM_ADMIN" } as unknown as PlatformContext;

      expect(() => platformActorOf(forged)).toThrow(PlatformAccessDeniedError);
      await expect(findWorkspaces(db(), forged, { term: tenant.workspaceId })).rejects.toThrow(PlatformAccessDeniedError);
    });

    it("is refused by every customer authorization helper, which is the point of the separate brand", () => {
      // The defect this prevents: a context minted for an operator carrying customer OWNER authority.
      // `scopeOf` rejecting it is not an obstacle to work around — it is the guarantee.
      expect(() => scopeOf(admin as never)).toThrow(WorkspaceAccessDeniedError);
      expect(() => profileScopeOf(admin as never)).toThrow();
      expect(() => requireRole(admin as never, ["OWNER"], "do anything")).toThrow(WorkspaceAccessDeniedError);
    });

    it("gives a customer's own context no platform authority either", () => {
      expect(() => platformActorOf(tenant.context as never)).toThrow(PlatformAccessDeniedError);
    });

    it("holds exactly the permissions its role's matrix row names", () => {
      // Iterated over the matrix rather than spot-checked, so a row changed in the domain cannot drift
      // away from what the store enforces.
      const contexts: Readonly<Record<PlatformRole, PlatformContext>> = { SUPPORT: support, BILLING: billing, OPERATIONS: operations, PLATFORM_ADMIN: admin };
      for (const role of PLATFORM_ROLES) {
        for (const permission of PLATFORM_PERMISSIONS) {
          const held = PLATFORM_PERMISSION_MATRIX[role].includes(permission);
          const act = () => requirePlatformPermission(contexts[role], permission, "act");
          if (held) {
            expect(act, `${role} should hold ${permission}`).not.toThrow();
          } else {
            expect(act, `${role} should not hold ${permission}`).toThrow(PlatformPermissionError);
          }
        }
      }
    });

    it("keeps break-glass away from support and billing mutation away from the role that grants roles", () => {
      // The two separations #59 and ADMIN_OPERATIONS.md actually insist on, asserted as sentences rather
      // than left to be read out of the matrix.
      expect(PLATFORM_PERMISSION_MATRIX.SUPPORT).not.toContain("BREAK_GLASS");
      expect(PLATFORM_PERMISSION_MATRIX.SUPPORT).not.toContain("WRITE_BILLING");
      expect(PLATFORM_PERMISSION_MATRIX.PLATFORM_ADMIN).not.toContain("WRITE_BILLING");
      expect(PLATFORM_PERMISSION_MATRIX.BILLING).not.toContain("OPEN_SUPPORT_SESSION");
    });
  });

  describe("metadata, which needs no session", () => {
    it("finds a workspace by id and by name", async () => {
      const byId = await findWorkspaces(db(), support, { term: tenant.workspaceId });
      const byName = await findWorkspaces(db(), support, { term: "platform-tenant" });

      expect(byId.map((hit) => hit.workspaceId)).toContain(tenant.workspaceId);
      expect(byName.map((hit) => hit.workspaceId)).toContain(tenant.workspaceId);
      expect(await findWorkspaces(db(), support, { term: "   " })).toEqual([]);
    });

    it("reports the operational picture without a session, and without a message body", async () => {
      const snapshot = await readSupportSnapshot(db(), support, tenant.workspaceId, NOW);

      expect(snapshot?.workspaceId).toBe(tenant.workspaceId);
      expect(snapshot?.profiles.length).toBeGreaterThan(0);
      expect(snapshot?.channels.length).toBeGreaterThan(0);
      expect(snapshot?.entitlement.state).toBeTruthy();
      expect(snapshot?.lastInboundAt).toBeInstanceOf(Date);
      // Nothing in the snapshot's shape can carry a customer's words: the type has no field for one.
      expect(JSON.stringify(snapshot)).not.toContain("hello from");
    });

    it("says plainly that a workspace does not exist, rather than throwing", async () => {
      // `readUsageAnchorDay` uses `findUniqueOrThrow`, which would have conflated "no such tenant" with
      // "something failed" — and a console has to tell an operator which.
      expect(await readSupportSnapshot(db(), support, "01a00000-0000-7000-8000-000000000000", NOW)).toBeNull();
    });

    it("opens no usage cycle for a tenant that has counted nothing", async () => {
      // The defect the critique found before a line was written: `readUsage` opens the cycle, and opening
      // it *creates the row*. An operator's read-only panel would have written into the customer's tenant
      // with no actor and no audit trail, failing "every operator action is attributable" on page load.
      const fresh = await seedWorkspace(db(), "platform-untouched");
      const before = await db().usageCycle.count({ where: { workspaceId: fresh.workspaceId } });

      const snapshot = await readSupportSnapshot(db(), support, fresh.workspaceId, NOW);

      expect(before).toBe(0);
      expect(await db().usageCycle.count({ where: { workspaceId: fresh.workspaceId } })).toBe(0);
      expect(snapshot?.usage.cycleOpened).toBe(false);
      expect(snapshot?.usage.periodStartsAt).toBeInstanceOf(Date);
    });
  });

  describe("a support access session", () => {
    it("is what unlocks a customer's correspondence, and nothing else does", async () => {
      const profile = tenant.profiles[0];
      if (profile === undefined) {
        throw new Error("the fixture has no profile");
      }
      const target = { workspaceId: tenant.workspaceId, businessProfileId: profile.businessProfileId, conversationId: profile.conversationId };

      // Without a session: refused, and the refusal says why rather than returning an empty list.
      const none = await readSupportScope(db(), support, { workspaceId: tenant.workspaceId }, NOW);
      expect(none).toMatchObject({ granted: [], refusal: "NO_SESSION" });
      await expect(readConversationContent(db(), support, none, target)).rejects.toThrow(PlatformPermissionError);

      // With one: the same read returns the customer's own words.
      const opened = await openSupportAccessSession(db(), support, {
        workspaceId: tenant.workspaceId,
        scopes: ["CONVERSATION_CONTENT"],
        reason: "ticket 4411: customer says replies stopped",
        ticketRef: "4411",
        at: NOW,
      });
      const granted = await readSupportScope(db(), support, { workspaceId: tenant.workspaceId }, NOW);
      expect(granted.granted).toEqual(["CONVERSATION_CONTENT"]);
      expect(granted.sessionId).toBe(opened.sessionId);

      const lines = await readConversationContent(db(), support, granted, target);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.some((line) => (line.text ?? "").includes("hello from"))).toBe(true);
    });

    it("stops granting the moment its clock runs out", async () => {
      const operator = await staff("expiring", "SUPPORT");
      await openSupportAccessSession(db(), operator, {
        workspaceId: tenant.workspaceId,
        scopes: ["CONVERSATION_CONTENT"],
        reason: "short session",
        durationMs: 60_000,
        at: NOW,
      });

      expect((await readSupportScope(db(), operator, { workspaceId: tenant.workspaceId }, new Date(NOW.getTime() + 30_000))).granted).toEqual([
        "CONVERSATION_CONTENT",
      ]);
      // One second past the expiry. Derived from the row and a clock, so there is no window in which a
      // lapsed session still reads as live because nobody re-read it.
      expect(await readSupportScope(db(), operator, { workspaceId: tenant.workspaceId }, new Date(NOW.getTime() + 60_001))).toMatchObject({
        granted: [],
        refusal: "EXPIRED",
      });
    });

    it("grants nothing for another workspace, or another profile", async () => {
      const operator = await staff("scoped", "SUPPORT");
      const profile = tenant.profiles[0];
      const otherProfile = otherTenant.profiles[0];
      if (profile === undefined || otherProfile === undefined) {
        throw new Error("the fixture has no profile");
      }
      await openSupportAccessSession(db(), operator, {
        workspaceId: tenant.workspaceId,
        businessProfileId: profile.businessProfileId,
        scopes: ["CONVERSATION_CONTENT"],
        reason: "one profile only",
        at: NOW,
      });

      // Another tenant entirely: no session at all for it.
      expect(await readSupportScope(db(), operator, { workspaceId: otherTenant.workspaceId }, NOW)).toMatchObject({ refusal: "NO_SESSION" });
      // The right tenant, the whole workspace: more than the session granted.
      expect(await readSupportScope(db(), operator, { workspaceId: tenant.workspaceId }, NOW)).toMatchObject({ refusal: "NO_SESSION" });
      // The profile it names: granted.
      const scope = await readSupportScope(db(), operator, { workspaceId: tenant.workspaceId, businessProfileId: profile.businessProfileId }, NOW);
      expect(scope.granted).toEqual(["CONVERSATION_CONTENT"]);
      // And a live scope cannot be pointed at another tenant's conversation.
      await expect(
        readConversationContent(db(), operator, scope, {
          workspaceId: otherTenant.workspaceId,
          businessProfileId: otherProfile.businessProfileId,
          conversationId: otherProfile.conversationId,
        }),
      ).rejects.toThrow(DbInputError);
    });

    it("is revoked once, and a second revocation changes nothing", async () => {
      const operator = await staff("revoking", "OPERATIONS");
      const opened = await openSupportAccessSession(db(), operator, {
        workspaceId: tenant.workspaceId,
        scopes: ["CONVERSATION_CONTENT"],
        reason: "will be revoked",
        at: NOW,
      });

      expect(await revokeSupportAccessSession(db(), operator, { sessionId: opened.sessionId, reason: "finished", at: NOW })).toEqual({ revoked: true });
      // Idempotent, and no second audit row: the log should say what happened, and nothing happened.
      expect(await revokeSupportAccessSession(db(), operator, { sessionId: opened.sessionId, reason: "again", at: NOW })).toEqual({ revoked: false });
      expect(await db().platformAuditEvent.count({ where: { kind: "SUPPORT_SESSION_REVOKED", subjectId: opened.sessionId } })).toBe(1);
      // `REVOKED` rather than `NO_SESSION`: the derivation reads the row and says what became of it, so
      // an operator is told their access was withdrawn instead of being told it never existed.
      expect(await readSupportScope(db(), operator, { workspaceId: tenant.workspaceId }, NOW)).toMatchObject({ granted: [], refusal: "REVOKED" });
    });

    it("cannot be widened, extended or deleted once granted", async () => {
      const operator = await staff("immutable", "SUPPORT");
      const opened = await openSupportAccessSession(db(), operator, {
        workspaceId: tenant.workspaceId,
        scopes: ["CONVERSATION_CONTENT"],
        reason: "fixed grant",
        durationMs: 60_000,
        at: NOW,
      });

      // Widening the scope or pushing the expiry would turn a short grant into a standing one without a
      // second authorisation, so the row refuses both.
      await expect(
        db().$executeRawUnsafe(`UPDATE "support_access_sessions" SET "scopes" = ARRAY['CONVERSATION_CONTENT','BILLING_DETAIL']::TEXT[] WHERE "id" = '${opened.sessionId}'`),
      ).rejects.toThrow(/not widened or extended/u);
      await expect(
        db().$executeRawUnsafe(`UPDATE "support_access_sessions" SET "expires_at" = NOW() + INTERVAL '7 days' WHERE "id" = '${opened.sessionId}'`),
      ).rejects.toThrow(/not widened or extended/u);
      await expect(db().$executeRawUnsafe(`DELETE FROM "support_access_sessions" WHERE "id" = '${opened.sessionId}'`)).rejects.toThrow(/never deleted/u);
    });

    it("refuses a session that grants nothing, or one with no stated reason", async () => {
      await expect(
        openSupportAccessSession(db(), support, { workspaceId: tenant.workspaceId, scopes: [], reason: "because", at: NOW }),
      ).rejects.toThrow(/grants nothing/u);
      await expect(
        openSupportAccessSession(db(), support, { workspaceId: tenant.workspaceId, scopes: ["CONVERSATION_CONTENT"], reason: "  ", at: NOW }),
      ).rejects.toThrow(/nobody can explain/u);
    });

    it("refuses a profile that belongs to another tenant", async () => {
      const otherProfile = otherTenant.profiles[0];
      if (otherProfile === undefined) {
        throw new Error("the fixture has no profile");
      }

      await expect(
        openSupportAccessSession(db(), support, {
          workspaceId: tenant.workspaceId,
          businessProfileId: otherProfile.businessProfileId,
          scopes: ["CONVERSATION_CONTENT"],
          reason: "cross-tenant attempt",
          at: NOW,
        }),
      ).rejects.toThrow(DbInputError);
    });

    it("lists who has been in a workspace, with live computed rather than stored", async () => {
      const rows = await listSupportSessions(db(), admin, tenant.workspaceId, NOW);

      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.reason).not.toBe("");
        expect(row.live).toBe(row.revokedAt === null && row.expiresAt.getTime() > NOW.getTime());
      }
    });
  });

  describe("break-glass", () => {
    it("is a separate permission, a CRITICAL audit row, and a chain that reads as a chain", async () => {
      await expect(
        openSupportAccessSession(db(), support, {
          workspaceId: tenant.workspaceId,
          scopes: ["CONVERSATION_CONTENT"],
          reason: "urgent",
          breakGlass: true,
          at: NOW,
        }),
      ).rejects.toThrow(PlatformPermissionError);

      const first = await openSupportAccessSession(db(), admin, {
        workspaceId: tenant.workspaceId,
        scopes: ["CONVERSATION_CONTENT"],
        reason: "incident 77: sends stopped platform-wide",
        breakGlass: true,
        at: NOW,
      });
      const second = await openSupportAccessSession(db(), admin, {
        workspaceId: tenant.workspaceId,
        scopes: ["CONVERSATION_CONTENT"],
        reason: "incident 77 continued",
        breakGlass: true,
        at: new Date(NOW.getTime() + BREAK_GLASS_MAX_MS + 1000),
      });

      expect(first.breakGlassInWindow).toBe(1);
      // Nothing caps renewal — whether one exists is policy — but the count makes a continuous chain of
      // short grants legible as what it is rather than as several unrelated careful decisions.
      expect(second.breakGlassInWindow).toBe(2);
      const rows = await db().platformAuditEvent.findMany({
        where: { kind: "BREAK_GLASS_OPENED", subjectId: { in: [first.sessionId, second.sessionId] } },
        select: { severity: true, detail: true, supportSessionId: true },
      });
      expect(rows.length).toBe(2);
      for (const row of rows) {
        expect(row.severity).toBe("CRITICAL");
        expect(row.supportSessionId).toBeTruthy();
        expect(JSON.stringify(row.detail)).toContain("breakGlassInWindow");
      }
    });

    it("cannot last longer than fifteen minutes, whoever writes the row", async () => {
      await expect(
        openSupportAccessSession(db(), admin, {
          workspaceId: tenant.workspaceId,
          scopes: ["CONVERSATION_CONTENT"],
          reason: "too long",
          breakGlass: true,
          durationMs: 60 * 60 * 1000,
          at: NOW,
        }),
      ).resolves.toMatchObject({ expiresAt: new Date(NOW.getTime() + BREAK_GLASS_MAX_MS) });

      // Clamped by the store, and refused outright by the row — a maximum a caller could widen is not a
      // maximum, and break-glass is exactly the path somebody reaches for in a hurry.
      const member = await db().platformMember.findFirstOrThrow({ where: { role: "PLATFORM_ADMIN" }, select: { id: true } });
      await expect(
        db().$executeRawUnsafe(
          `INSERT INTO "support_access_sessions" ("id","platform_member_id","actor_role","workspace_id","scopes","reason","break_glass","started_at","expires_at")
           VALUES ('raw-break-glass','${member.id}','PLATFORM_ADMIN','${tenant.workspaceId}',ARRAY['CONVERSATION_CONTENT']::TEXT[],'raw',true,NOW(),NOW() + INTERVAL '2 hours')`,
        ),
      ).rejects.toThrow(/support_access_sessions_clock_check/u);
    });
  });

  describe("the kill switch, from a console instead of from a SQL prompt", () => {
    it("pulls at a scope, records the operator, and audits it", async () => {
      const pulled = await pullKillSwitch(db(), operations, {
        scope: "WORKSPACE",
        workspaceId: tenant.workspaceId,
        reason: "incident 77: holding outbound while the provider recovers",
        at: NOW,
      });

      const row = await db().automationSuspension.findUniqueOrThrow({
        where: { id: pulled.suspensionId },
        select: { scope: true, reason: true, note: true, byUserId: true, workspaceId: true },
      });
      expect(row).toMatchObject({ scope: "WORKSPACE", reason: "OPERATOR", workspaceId: tenant.workspaceId });
      // The actor is what keeps the backlog guard out of an operator's switch: it identifies the system's
      // own by the actor being absent.
      expect(row.byUserId).toBeTruthy();
      expect(row.note).toContain("incident 77");

      const audit = await db().platformAuditEvent.findFirstOrThrow({
        where: { kind: "KILL_SWITCH_PULLED", subjectId: pulled.suspensionId },
        select: { severity: true, reason: true, workspaceId: true },
      });
      expect(audit).toMatchObject({ severity: "WARNING", workspaceId: tenant.workspaceId });
      expect(audit.reason).toContain("incident 77");

      // And the snapshot reports it, read through the same path the delivery claim uses.
      expect((await readSupportSnapshot(db(), operations, tenant.workspaceId, NOW))?.pause).toMatchObject({ scope: "WORKSPACE", byOperator: true });

      expect(await liftKillSwitch(db(), operations, { suspensionId: pulled.suspensionId, reason: "provider recovered", at: NOW })).toEqual({ lifted: true });
      // Idempotent, and the audit says what happened once.
      expect(await liftKillSwitch(db(), operations, { suspensionId: pulled.suspensionId, reason: "again", at: NOW })).toEqual({ lifted: false });
      expect(await db().platformAuditEvent.count({ where: { kind: "KILL_SWITCH_LIFTED", subjectId: pulled.suspensionId } })).toBe(1);
      expect((await readSupportSnapshot(db(), operations, tenant.workspaceId, NOW))?.pause).toBeUndefined();
    });

    it("refuses a narrow scope whose identifiers are missing", async () => {
      // A `BUSINESS_PROFILE` switch with no profile named is a global stop wearing a narrow label — the
      // most dangerous shape, because it looks contained and is not.
      await expect(pullKillSwitch(db(), operations, { scope: "BUSINESS_PROFILE", workspaceId: tenant.workspaceId, reason: "no profile", at: NOW })).rejects.toThrow();
      await expect(pullKillSwitch(db(), operations, { scope: "WORKSPACE", reason: "no workspace", at: NOW })).rejects.toThrow();
    });

    it("refuses an operator pause with no actor, whoever writes the row", async () => {
      await expect(
        db().$executeRawUnsafe(
          `INSERT INTO "automation_suspensions" ("id","scope","reason","since","updated_at") VALUES ('raw-actorless','GLOBAL','OPERATOR',NOW(),NOW())`,
        ),
      ).rejects.toThrow(/automation_suspensions_operator_check/u);
    });

    it("will not let a console end the system's own pause", async () => {
      // The backlog guard raised it to protect the queue. A console overruling that is a console
      // overruling the machinery; the way to end it is to fix the backlog.
      // Written already lapsed, so it cannot pause the tenant for the tests around it — the rule under
      // test is about the actor being absent, not about the window.
      const system = await db().automationSuspension.create({
        data: { scope: "GLOBAL", reason: "BACKLOG", note: "queue depth", since: new Date(NOW.getTime() - 600_000), until: new Date(NOW.getTime() - 300_000), byUserId: null },
        select: { id: true },
      });

      await expect(liftKillSwitch(db(), operations, { suspensionId: system.id, reason: "impatient", at: NOW })).rejects.toThrow(/the system's own pause/u);
    });

    it("is offered only to the role that holds it, and lists what is in force", async () => {
      await expect(pullKillSwitch(db(), billing, { scope: "GLOBAL", reason: "not mine", at: NOW })).rejects.toThrow(PlatformPermissionError);

      const global = await pullKillSwitch(db(), admin, { scope: "GLOBAL", reason: "platform-wide hold", until: new Date(NOW.getTime() + 600_000), at: NOW });
      const live = await listKillSwitches(db(), admin, { at: NOW });
      expect(live.map((row) => row.suspensionId)).toContain(global.suspensionId);
      expect(live.find((row) => row.suspensionId === global.suspensionId)).toMatchObject({ scope: "GLOBAL", byOperator: true });

      await liftKillSwitch(db(), admin, { suspensionId: global.suspensionId, reason: "done", at: NOW });
      expect((await listKillSwitches(db(), admin, { at: NOW })).map((row) => row.suspensionId)).not.toContain(global.suspensionId);
    });
  });

  describe("ambiguous operations", () => {
    it("lists them with the state, the evidence and the correlation id the sweeper's query omits", async () => {
      const rows = await listReconciliations(db(), operations, { workspaceId: tenant.workspaceId });

      // The fixture has none, which is the honest empty case; what matters is the shape being readable.
      expect(Array.isArray(rows)).toBe(true);
      await expect(requestReconciliation(db(), operations, { operationId: "01a00000-0000-7000-8000-000000000000", reason: "probe", at: NOW })).rejects.toThrow(
        /no ambiguous operation/u,
      );
    });

    it("records who asked for a re-examination, and refuses one that is already concluded", async () => {
      const profile = tenant.profiles[0];
      if (profile === undefined) {
        throw new Error("the fixture has no profile");
      }
      const operationId = "01a20000-0000-7000-8000-00000000aaaa";
      // A delivery job and its reconciliation record, written directly: this suite is about the console's
      // action, and the coordinator's own path to an ambiguous send has its own tests.
      await db().$executeRawUnsafe(
        // A human-composed job. Three constraints shape this row, and the fact that it took three
        // attempts to write is itself the argument for them: `delivery_jobs_conversation_origin_check`
        // pairs `human_text` with `conversation_id`, `delivery_jobs_composer_check` pairs it with
        // `composed_by_user_id`, and `delivery_jobs_authority_check` pairs `HUMAN_APPROVED` with all
        // four approval columns. A delivery whose origin is half-recorded cannot exist.
        `INSERT INTO "delivery_jobs" ("id","workspace_id","business_profile_id","conversation_id","human_text","composed_by_user_id","operation_id","correlation_id","status","authority","approved_by_user_id","approved_at","approved_review_mode","decision_key","scheduled_for","selected_delay_ms","updated_at")
         VALUES ('dj-platform','${tenant.workspaceId}','${profile.businessProfileId}','${profile.conversationId}','composed reply','${tenant.ownerUserId}','${operationId}','corr-platform','HELD_AMBIGUOUS','HUMAN_APPROVED','${tenant.ownerUserId}',NOW(),'NORMAL','dk-platform',NOW(),0,NOW())`,
      );
      await db().$executeRawUnsafe(
        `INSERT INTO "delivery_reconciliations" ("id","workspace_id","business_profile_id","operation_id","delivery_job_id","conversation_id","reason","state","detected_at","updated_at")
         VALUES ('dr-platform','${tenant.workspaceId}','${profile.businessProfileId}','${operationId}','dj-platform','${profile.conversationId}','AMBIGUOUS_SEND_RESULT','PENDING',NOW(),NOW())`,
      );

      const requested = await requestReconciliation(db(), operations, { operationId, reason: "customer says it never arrived", at: NOW });
      expect(requested).toMatchObject({ workspaceId: tenant.workspaceId, state: "PENDING" });
      const audit = await db().platformAuditEvent.findFirstOrThrow({
        where: { kind: "RECONCILIATION_REQUESTED", subjectId: operationId },
        select: { severity: true, detail: true },
      });
      expect(audit.severity).toBe("INFO");
      expect(JSON.stringify(audit.detail)).toContain("PENDING");

      const listed = await listReconciliations(db(), operations, { workspaceId: tenant.workspaceId });
      expect(listed.map((row) => row.operationId)).toContain(operationId);

      // Concluded: refused. Re-examining a settled send is how a duplicate gets sent.
      // `delivery_reconciliations_attempt_check` pairs a terminal state with at least one attempt: a
      // record that concluded without ever having been examined is not a conclusion.
      await db().$executeRawUnsafe(
        `UPDATE "delivery_reconciliations" SET "state" = 'RESOLVED_SENT', "resolved_at" = NOW(), "attempt_count" = 1, "last_attempt_at" = NOW() WHERE "id" = 'dr-platform'`,
      );
      await expect(requestReconciliation(db(), operations, { operationId, reason: "again", at: NOW })).rejects.toThrow(/already concluded/u);
    });

    it("is offered only to the role that holds it", async () => {
      await expect(requestReconciliation(db(), billing, { operationId: "x", reason: "not mine", at: NOW })).rejects.toThrow(PlatformPermissionError);
    });
  });

  describe("the internal audit", () => {
    it("derives severity from the kind, and refuses a row that disagrees", async () => {
      const member = await db().platformMember.findFirstOrThrow({ where: { role: "SUPPORT" }, select: { id: true } });

      await expect(
        db().$executeRawUnsafe(
          `INSERT INTO "platform_audit_events" ("id","platform_member_id","actor_role","kind","severity","subject_type","subject_id","reason")
           VALUES ('raw-severity','${member.id}','SUPPORT','BREAK_GLASS_OPENED','INFO','SupportAccessSession','s-1','wrong severity')`,
        ),
      ).rejects.toThrow(/platform_audit_events_severity_check/u);
      // And the derivation the store uses agrees with the constraint for every kind.
      expect(platformAuditSeverity("BREAK_GLASS_OPENED")).toBe("CRITICAL");
      expect(platformAuditSeverity("CUSTOMER_CONTENT_READ")).toBe("CRITICAL");
      expect(platformAuditSeverity("WORKSPACE_INSPECTED")).toBe("INFO");
    });

    it("refuses a content read that names no session", async () => {
      const member = await db().platformMember.findFirstOrThrow({ where: { role: "SUPPORT" }, select: { id: true } });

      await expect(
        db().$executeRawUnsafe(
          `INSERT INTO "platform_audit_events" ("id","platform_member_id","actor_role","kind","severity","subject_type","subject_id","reason")
           VALUES ('raw-no-session','${member.id}','SUPPORT','CUSTOMER_CONTENT_READ','CRITICAL','Conversation','c-1','no session named')`,
        ),
      ).rejects.toThrow(/platform_audit_events_session_check/u);
    });

    it("refuses a row with no stated reason", async () => {
      await expect(
        recordPlatformAuditEvent(db(), support, { kind: "WORKSPACE_INSPECTED", subjectType: "Workspace", subjectId: tenant.workspaceId, reason: "  " }),
      ).rejects.toThrow(DbInputError);
    });

    it("is append-only", async () => {
      const row = await db().platformAuditEvent.findFirstOrThrow({ select: { id: true } });

      await expect(db().$executeRawUnsafe(`UPDATE "platform_audit_events" SET "reason" = 'edited' WHERE "id" = '${row.id}'`)).rejects.toThrow(/append-only/u);
      await expect(db().$executeRawUnsafe(`DELETE FROM "platform_audit_events" WHERE "id" = '${row.id}'`)).rejects.toThrow(/append-only/u);
    });

    it("shows every operator their colleagues' actions, including the CRITICAL ones", async () => {
      // A log where staff cannot see each other's actions protects staff rather than customers, which is
      // backwards. What gates it is holding the permission at all.
      const page = await searchPlatformAuditEvents(db(), support, { severities: ["CRITICAL"], limit: 10 });

      expect(page.rows.length).toBeGreaterThan(0);
      expect(page.rows.every((row) => row.severity === "CRITICAL")).toBe(true);
      expect(page.rows.some((row) => row.kind === "BREAK_GLASS_OPENED")).toBe(true);
      // And it names the actor's role as it was, not as it is now.
      expect(page.rows.every((row) => PLATFORM_ROLES.includes(row.actorRole))).toBe(true);
    });

    it("pages with a cursor rather than an offset", async () => {
      const first = await searchPlatformAuditEvents(db(), admin, { limit: 2 });
      expect(first.rows.length).toBe(2);
      expect(first.nextCursor).toBeDefined();

      const second = await searchPlatformAuditEvents(db(), admin, { limit: 2, ...(first.nextCursor === undefined ? {} : { cursor: first.nextCursor }) });
      expect(second.rows.map((row) => row.id)).not.toEqual(first.rows.map((row) => row.id));
    });

    it("is written in the same transaction as the action it describes", async () => {
      // A row written afterwards is a row that is missing exactly when the interesting thing happened. The
      // proof: a failing action leaves no audit row behind.
      const before = await db().platformAuditEvent.count({ where: { kind: "KILL_SWITCH_PULLED" } });
      await expect(pullKillSwitch(db(), operations, { scope: "CHANNEL_ACCOUNT", workspaceId: tenant.workspaceId, reason: "no account named", at: NOW })).rejects.toThrow();

      expect(await db().platformAuditEvent.count({ where: { kind: "KILL_SWITCH_PULLED" } })).toBe(before);
    });
  });

  describe("granting a platform role", () => {
    it("is the platform admin's alone, and is audited", async () => {
      const newcomer = await createTestUser(db(), "platform-newcomer");

      await expect(setPlatformMember(db(), support, { userId: newcomer, role: "SUPPORT", note: "support rota" })).rejects.toThrow(PlatformPermissionError);
      await expect(setPlatformMember(db(), billing, { userId: newcomer, role: "SUPPORT", note: "support rota" })).rejects.toThrow(PlatformPermissionError);

      const granted = await setPlatformMember(db(), admin, { userId: newcomer, role: "SUPPORT", note: "joined the support rota", at: NOW });
      expect((await authorizePlatformAccess(db(), newcomer)).role).toBe("SUPPORT");
      const audit = await db().platformAuditEvent.findFirstOrThrow({
        where: { kind: "PLATFORM_MEMBER_CHANGED", subjectId: granted.platformMemberId },
        select: { severity: true, detail: true },
      });
      expect(audit.severity).toBe("WARNING");
      expect(JSON.stringify(audit.detail)).toContain("SUPPORT");

      // Withdrawn: the row stays, because audit rows point at it, and authorization refuses.
      await setPlatformMember(db(), admin, { userId: newcomer, role: "SUPPORT", note: "left the rota", revoke: true, at: NOW });
      await expect(authorizePlatformAccess(db(), newcomer)).rejects.toThrow(PlatformAccessDeniedError);
    });

    it("dates the row from the stated instant, not from the database clock", async () => {
      const newcomer = await createTestUser(db(), "platform-backdated");
      const backdated = new Date("2026-09-01T09:00:00.000Z");

      await setPlatformMember(db(), admin, { userId: newcomer, role: "SUPPORT", note: "joined the rota", at: backdated });
      const member = await db().platformMember.findUniqueOrThrow({ where: { userId: newcomer }, select: { createdAt: true } });
      expect(member.createdAt).toEqual(backdated);

      // And a withdrawal at that same instant is accepted. `platform_members_shape_check` compares the two
      // columns, so taking the creation from `now()` while writing a stated revocation refuses every
      // backdated withdrawal — and makes any test that states an instant depend on the wall clock not yet
      // having reached it.
      await setPlatformMember(db(), admin, { userId: newcomer, role: "SUPPORT", note: "left the rota", revoke: true, at: backdated });
      await expect(authorizePlatformAccess(db(), newcomer)).rejects.toThrow(PlatformAccessDeniedError);
    });

    it("refuses a role nobody can explain", async () => {
      const newcomer = await createTestUser(db(), "platform-unexplained");

      await expect(setPlatformMember(db(), admin, { userId: newcomer, role: "SUPPORT", note: "   " })).rejects.toThrow(DbInputError);
    });
  });

  describe("the access that has to leave a trace", () => {
    /**
     * Astra's P1 on PR #102. `readConversationContent` checked the scope, selected the messages and
     * returned a customer's private correspondence, and the comment above it said the *caller* records
     * `CUSTOMER_CONTENT_READ`. No caller did: repository-wide there was no production writer of that kind
     * or of `WORKSPACE_INSPECTED` at all, so the console released content leaving nothing that could say
     * which conversation was read, when, or whether the session an operator held had ever been used.
     * Opening and revoking sessions was audited, and neither answers that.
     *
     * The audit is now written inside the same transaction that selects the messages, which is what makes
     * these assertions about more than a shape: a failed audit rolls the read back.
     */
    async function sessionFor(target: Awaited<ReturnType<typeof seedWorkspace>>, reason: string) {
      await openSupportAccessSession(db(), support, {
        workspaceId: target.workspaceId,
        scopes: ["CONVERSATION_CONTENT"],
        reason,
        at: NOW,
      });
      return readSupportScope(db(), support, { workspaceId: target.workspaceId }, NOW);
    }

    function targetOf(seeded: Awaited<ReturnType<typeof seedWorkspace>>) {
      const profile = seeded.profiles[0];
      if (profile === undefined) {
        throw new Error("the fixture has no profile");
      }
      return { workspaceId: seeded.workspaceId, businessProfileId: profile.businessProfileId, conversationId: profile.conversationId };
    }

    it("files a CRITICAL content read naming the session, the conversation and what it released", async () => {
      const seeded = await seedWorkspace(db(), "audit-content");
      const target = targetOf(seeded);
      const reason = "ticket 9001: customer disputes a reply we sent";
      const scope = await sessionFor(seeded, reason);

      const lines = await readConversationContent(db(), support, scope, target, NOW);
      expect(lines.length).toBeGreaterThan(0);

      const rows = await db().platformAuditEvent.findMany({
        where: { kind: "CUSTOMER_CONTENT_READ", workspaceId: seeded.workspaceId },
        select: {
          severity: true,
          reason: true,
          subjectType: true,
          subjectId: true,
          workspaceId: true,
          businessProfileId: true,
          supportSessionId: true,
          platformMemberId: true,
          detail: true,
        },
      });
      // Exactly one, not zero — zero is what this path produced before — and not two.
      expect(rows.length).toBe(1);
      const row = rows[0];
      expect(row).toMatchObject({
        // Derived from the kind rather than passed, so a caller cannot file a content read as INFO.
        severity: "CRITICAL",
        subjectType: "Conversation",
        subjectId: target.conversationId,
        workspaceId: target.workspaceId,
        businessProfileId: target.businessProfileId,
        // The authority. Its CHECK requires it, and the session is what a dispute asks about.
        supportSessionId: scope.sessionId,
      });
      expect(row?.platformMemberId).toBeTruthy();
      // The session's own stated purpose, so the record answers "why" without joining back to the open.
      expect(row?.reason).toContain("ticket 9001");
      expect(row?.detail).toMatchObject({ granted: ["CONVERSATION_CONTENT"], breakGlass: false, messagesRead: lines.length });
    });

    it("files nothing when the read is refused, because nothing was released", async () => {
      const seeded = await seedWorkspace(db(), "audit-refused");
      const target = targetOf(seeded);

      // No session at all.
      const none = await readSupportScope(db(), support, { workspaceId: seeded.workspaceId }, NOW);
      await expect(readConversationContent(db(), support, none, target, NOW)).rejects.toThrow(PlatformPermissionError);

      // A live session for this workspace pointed at somebody else's: refused on the target, not the grant.
      const scope = await sessionFor(seeded, "ticket 9002: checking a quiet inbox");
      const elsewhere = { ...target, workspaceId: otherTenant.workspaceId };
      await expect(readConversationContent(db(), support, scope, elsewhere, NOW)).rejects.toThrow(DbInputError);

      expect(await db().platformAuditEvent.count({ where: { kind: "CUSTOMER_CONTENT_READ", workspaceId: seeded.workspaceId } })).toBe(0);
      expect(await db().platformAuditEvent.count({ where: { kind: "CUSTOMER_CONTENT_READ", workspaceId: otherTenant.workspaceId } })).toBe(0);
    });

    it("withholds the correspondence when the audit row cannot be written", async () => {
      // The half that makes the other assertions mean something. The audit and the select share one
      // transaction, so this proves the direction of the dependency: if the record cannot be kept, the
      // content does not leave the database. The real client is proxied so only that one insert fails —
      // every other query still runs against PostgreSQL.
      const seeded = await seedWorkspace(db(), "audit-fails");
      const target = targetOf(seeded);
      const scope = await sessionFor(seeded, "ticket 9003: storage is about to refuse");

      const refusing = new Proxy(db(), {
        get(client, property, receiver) {
          if (property !== "$transaction") {
            return Reflect.get(client, property, receiver) as unknown;
          }
          return (callback: (tx: DbExecutor) => Promise<unknown>, ...rest: readonly unknown[]) =>
            client.$transaction(
              (tx) =>
                callback(
                  new Proxy(tx, {
                    get(inner, model, innerReceiver) {
                      if (model !== "platformAuditEvent") {
                        return Reflect.get(inner, model, innerReceiver) as unknown;
                      }
                      return {
                        create: () => {
                          throw new Error("platform_audit_events is unavailable");
                        },
                      };
                    },
                  }),
                ),
              ...(rest as []),
            );
        },
      });

      await expect(readConversationContent(refusing, support, scope, target, NOW)).rejects.toThrow(/unavailable/u);
      // Nothing recorded, and — the point — nothing returned either.
      expect(await db().platformAuditEvent.count({ where: { kind: "CUSTOMER_CONTENT_READ", workspaceId: seeded.workspaceId } })).toBe(0);
      // The messages are still there; the refusal withheld them rather than destroying anything.
      const after = await readConversationContent(db(), support, scope, target, NOW);
      expect(after.length).toBeGreaterThan(0);
    });

    it("files an inspection when a workspace snapshot is read, and nothing when there is no workspace", async () => {
      const seeded = await seedWorkspace(db(), "audit-inspect");

      const snapshot = await readSupportSnapshot(db(), support, seeded.workspaceId, NOW);
      expect(snapshot?.workspaceId).toBe(seeded.workspaceId);

      const rows = await db().platformAuditEvent.findMany({
        where: { kind: "WORKSPACE_INSPECTED", workspaceId: seeded.workspaceId },
        select: { severity: true, subjectType: true, subjectId: true, supportSessionId: true, detail: true },
      });
      expect(rows.length).toBe(1);
      expect(rows[0]).toMatchObject({
        // Metadata, so INFO rather than CRITICAL — and no session, because none is needed to look.
        severity: "INFO",
        subjectType: "Workspace",
        subjectId: seeded.workspaceId,
        supportSessionId: null,
      });

      // A lookup that found nothing inspected nothing.
      const before = await db().platformAuditEvent.count({ where: { kind: "WORKSPACE_INSPECTED" } });
      expect(await readSupportSnapshot(db(), support, "no-such-workspace", NOW)).toBeNull();
      expect(await db().platformAuditEvent.count({ where: { kind: "WORKSPACE_INSPECTED" } })).toBe(before);
    });
  });

  describe("expiry and scope are both predicates", () => {
    /**
     * Astra's first P2 on PR #102. The `where` object held `OR: [{until: null}, {until: {gt: at}}]` and
     * then spread a second `OR` for the scope, so naming a workspace **replaced** the expiry predicate:
     * the workspace console listed suspensions that had already run out as if they were still in force,
     * while the unfiltered home list — which never set the second key — excluded them correctly. Expired
     * rows could also consume the hundred-row cap and hide switches that really were active.
     */
    it("excludes an expired switch from the workspace list exactly as it does from the unfiltered one", async () => {
      const seeded = await seedWorkspace(db(), "expiry-scope");
      const expired = await pullKillSwitch(db(), operations, {
        scope: "WORKSPACE",
        workspaceId: seeded.workspaceId,
        reason: "incident 91: holding outbound for ten minutes",
        until: new Date(NOW.getTime() - 1_000),
        at: new Date(NOW.getTime() - 60_000),
      });
      const profile = seeded.profiles[0];
      if (profile === undefined) {
        throw new Error("the fixture has no profile");
      }
      const active = await pullKillSwitch(db(), operations, {
        scope: "BUSINESS_PROFILE",
        workspaceId: seeded.workspaceId,
        businessProfileId: profile.businessProfileId,
        reason: "incident 92: still holding this profile",
        at: NOW,
      });

      const unfiltered = await listKillSwitches(db(), operations, { at: NOW });
      const scoped = await listKillSwitches(db(), operations, { workspaceId: seeded.workspaceId, at: NOW });

      // The two lists have to agree about what is in force. Before the fix the scoped one was the only
      // place the expired row appeared, which is exactly the list an operator uses to decide.
      for (const [label, rows] of [["unfiltered", unfiltered] as const, ["scoped", scoped] as const]) {
        const ids = rows.map((row) => row.suspensionId);
        expect(ids, `${label} must not offer an expired switch`).not.toContain(expired.suspensionId);
        expect(ids, `${label} must still offer the active one`).toContain(active.suspensionId);
      }

      // And the scope filter still filters: another tenant's active switch is not in this list.
      expect(scoped.map((row) => row.workspaceId).filter((id) => id !== null && id !== seeded.workspaceId)).toEqual([]);
    });
  });

  describe("two operators, one transition", () => {
    /**
     * Astra's second P2 on PR #102. Both functions read the row, ran a conditional `updateMany` whose
     * predicate correctly let only one caller change it — and then **ignored the count**, appending a
     * success audit event and returning `true` either way. The winner's attribution was never at risk; the
     * record was: the loser filed a row claiming a state transition that never happened.
     *
     * Deterministic rather than hopeful. The barrier releases both transactions' initial reads before
     * either conditional update runs, so the interleaving is forced instead of waited for, on real
     * PostgreSQL with two real transactions.
     */
    function barrierFor(parties: number) {
      let arrived = 0;
      let open = () => {};
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      return async () => {
        arrived += 1;
        if (arrived >= parties) {
          open();
        }
        await gate;
      };
    }

    /** Holds every transaction at its first read of `model` until all of them have read. */
    function heldAtFirstRead(model: "automationSuspension" | "supportAccessSession", parties: number): DbClient {
      const wait = barrierFor(parties);
      return new Proxy(db(), {
        get(client, property, receiver) {
          if (property !== "$transaction") {
            return Reflect.get(client, property, receiver) as unknown;
          }
          return (callback: (tx: DbExecutor) => Promise<unknown>, ...rest: readonly unknown[]) =>
            client.$transaction(
              (tx) =>
                callback(
                  new Proxy(tx, {
                    get(inner, name, innerReceiver) {
                      const delegate = Reflect.get(inner, name, innerReceiver) as unknown;
                      if (name !== model) {
                        return delegate;
                      }
                      return new Proxy(delegate as object, {
                        get(owner, call, ownerReceiver) {
                          const original = Reflect.get(owner, call, ownerReceiver) as unknown;
                          if (call !== "findUnique" || typeof original !== "function") {
                            return original;
                          }
                          return async (...args: unknown[]) => {
                            const row = await (original as (...a: unknown[]) => Promise<unknown>).apply(owner, args);
                            await wait();
                            return row;
                          };
                        },
                      });
                    },
                  }),
                ),
              ...(rest as []),
            );
        },
      });
    }

    it("lets exactly one lift win, files exactly one lift, and keeps the winner's attribution", async () => {
      const seeded = await seedWorkspace(db(), "race-lift");
      const pulled = await pullKillSwitch(db(), operations, {
        scope: "WORKSPACE",
        workspaceId: seeded.workspaceId,
        reason: "incident 93: two operators will both reach for this",
        at: NOW,
      });
      const held = heldAtFirstRead("automationSuspension", 2);

      const results = await Promise.all([
        liftKillSwitch(held, operations, { suspensionId: pulled.suspensionId, reason: "first operator", at: NOW }),
        liftKillSwitch(held, admin, { suspensionId: pulled.suspensionId, reason: "second operator", at: NOW }),
      ]);

      // One transition, not two reports of one.
      expect(results.filter((result) => result.lifted).length).toBe(1);
      expect(results.filter((result) => !result.lifted).length).toBe(1);
      expect(await db().platformAuditEvent.count({ where: { kind: "KILL_SWITCH_LIFTED", subjectId: pulled.suspensionId } })).toBe(1);

      // And the row names whoever actually wrote it, which the predicate already guaranteed.
      const row = await db().automationSuspension.findUniqueOrThrow({
        where: { id: pulled.suspensionId },
        select: { liftedAt: true, liftedByUserId: true },
      });
      expect(row.liftedAt).not.toBeNull();
      expect(row.liftedByUserId).toBeTruthy();
      const filed = await db().platformAuditEvent.findFirstOrThrow({
        where: { kind: "KILL_SWITCH_LIFTED", subjectId: pulled.suspensionId },
        select: { reason: true },
      });
      // The surviving audit row is the winner's own reason, not an arbitrary one of the two.
      expect(["first operator", "second operator"]).toContain(filed.reason);
    });

    it("lets exactly one revocation win, and files exactly one revocation", async () => {
      const seeded = await seedWorkspace(db(), "race-revoke");
      const opened = await openSupportAccessSession(db(), support, {
        workspaceId: seeded.workspaceId,
        scopes: ["CONVERSATION_CONTENT"],
        reason: "ticket 9004: two operators will both close this",
        at: NOW,
      });
      const held = heldAtFirstRead("supportAccessSession", 2);

      const results = await Promise.all([
        revokeSupportAccessSession(held, support, { sessionId: opened.sessionId, reason: "first operator", at: NOW }),
        revokeSupportAccessSession(held, admin, { sessionId: opened.sessionId, reason: "second operator", at: NOW }),
      ]);

      expect(results.filter((result) => result.revoked).length).toBe(1);
      expect(results.filter((result) => !result.revoked).length).toBe(1);
      expect(await db().platformAuditEvent.count({ where: { kind: "SUPPORT_SESSION_REVOKED", subjectId: opened.sessionId } })).toBe(1);

      const row = await db().supportAccessSession.findUniqueOrThrow({
        where: { id: opened.sessionId },
        select: { revokedAt: true, revokedByMemberId: true },
      });
      expect(row.revokedAt).not.toBeNull();
      expect(row.revokedByMemberId).toBeTruthy();
    });
  });

  describe("the customer's own world is untouched", () => {
    it("never writes an operator action into the customer's audit log", async () => {
      // The inversion ADMIN_OPERATIONS.md forbids: an internal action appearing as a member's own action,
      // readable by that customer's owner.
      const customerAudit = await db().auditEvent.findMany({ where: { workspaceId: tenant.workspaceId }, select: { kind: true, actorUserId: true } });
      const operatorIds = (await db().platformMember.findMany({ select: { userId: true } })).map((member) => member.userId);

      expect(customerAudit.filter((row) => row.actorUserId !== null && operatorIds.includes(row.actorUserId))).toEqual([]);
    });

    it("adds no member and consumes no seat", async () => {
      const operatorIds = (await db().platformMember.findMany({ select: { userId: true } })).map((member) => member.userId);

      expect(await db().workspaceMember.count({ where: { userId: { in: operatorIds } } })).toBe(0);
    });

    it("leaves a channel account's credential untouched and unreadable through the console", async () => {
      const snapshot = await readSupportSnapshot(db(), admin, tenant.workspaceId, NOW);
      const serialized = JSON.stringify(snapshot);

      // The snapshot's type has no field for a credential, a capability blob or a token, so there is
      // nothing to redact — which is the only version of "no secrets" that survives a future `select`.
      expect(serialized).not.toContain("credentialId");
      expect(serialized).not.toContain("capabilities");
      expect(serialized).not.toContain("accessToken");
      void connectChannelAccount;
    });
  });
});
