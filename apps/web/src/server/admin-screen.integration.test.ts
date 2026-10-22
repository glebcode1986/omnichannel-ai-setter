/**
 * The console's own assembly, against a real database (#59, ADMIN_OPERATIONS.md).
 *
 * It drives `assembleAdminHome`, `assembleAdminWorkspace` and `assembleAdminConversation` rather than
 * reissuing their reads, for the reason the Style screen learned: a helper that rebuilt the loader's
 * queries would pass against a loader that had stopped making one of them.
 *
 * The pair that matters is the last two tests. A console screen that showed a customer's correspondence
 * without a session, or that refused it with one, would be the whole point of this issue inverted — and
 * neither can be proved by a pane test, because a pane only knows what it was handed.
 */
import {
  authorizePlatformAccess,
  openSupportAccessSession,
  revokeSupportAccessSession,
  type PlatformContext,
} from "@omnichannel/db";
import { PLATFORM_PERMISSION_MATRIX, type PlatformRole } from "@omnichannel/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assembleAdminAudit, assembleAdminConversation, assembleAdminHome, assembleAdminWorkspace } from "./admin-screen";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { createPaidWorkspace } from "./testing/paid-workspace";

const NOW = new Date("2026-10-08T12:00:00.000Z");
const BASE = "/admin";

describe.skipIf(!databaseTestsEnabled())("the operations console", () => {
  let database: TestDatabase;
  let tenant: Awaited<ReturnType<typeof createPaidWorkspace>>;
  let support: PlatformContext;
  let operations: PlatformContext;
  let billing: PlatformContext;
  const db = () => database.db;

  async function staff(label: string, role: PlatformRole): Promise<PlatformContext> {
    const user = await db().user.create({ data: { name: `Operator ${label}`, email: `${label}@platform.test` } });
    await db().platformMember.create({ data: { userId: user.id, role, note: `${label} rota` } });
    return authorizePlatformAccess(db(), user.id);
  }

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    tenant = await createPaidWorkspace(db(), "admin-console");
    support = await staff("support", "SUPPORT");
    operations = await staff("operations", "OPERATIONS");
    billing = await staff("billing", "BILLING");
  }, 300_000);

  afterAll(async () => {
    await database?.dispose();
  });

  it("finds a tenant and reports what an operator may be offered", async () => {
    const data = await assembleAdminHome(db(), support, { q: tenant.workspaceId }, BASE, NOW);

    expect(data.role).toBe("SUPPORT");
    expect(data.hits.map((hit) => hit.workspaceId)).toContain(tenant.workspaceId);
    // `can` is for drawing the page. The store refuses whatever it says, which the db suite asserts.
    expect(data.can.OPEN_SUPPORT_SESSION).toBe(true);
    expect(data.can.OPERATE_KILL_SWITCH).toBe(false);
    expect(data.can.BREAK_GLASS).toBe(false);
  }, 300_000);

  it("offers no search results until somebody searches", async () => {
    const data = await assembleAdminHome(db(), support, {}, BASE, NOW);

    // An unbounded listing of the whole customer base is a different feature with a different
    // conversation attached to it.
    expect(data.term).toBe("");
    expect(data.hits).toEqual([]);
  }, 300_000);

  it("derives each role's offered controls from the matrix rather than from a second list", async () => {
    const contexts: readonly [PlatformRole, PlatformContext][] = [
      ["SUPPORT", support],
      ["OPERATIONS", operations],
      ["BILLING", billing],
    ];
    for (const [role, context] of contexts) {
      const data = await assembleAdminHome(db(), context, {}, BASE, NOW);
      for (const [permission, offered] of Object.entries(data.can)) {
        expect(offered, `${role} ${permission}`).toBe(PLATFORM_PERMISSION_MATRIX[role].includes(permission as never));
      }
    }
  }, 300_000);

  it("reports the tenant's operational picture without opening a usage cycle", async () => {
    const before = await db().usageCycle.count({ where: { workspaceId: tenant.workspaceId } });

    const data = await assembleAdminWorkspace(db(), support, tenant.workspaceId, BASE, NOW);

    expect(data.snapshot?.name).toContain("admin-console");
    expect(data.snapshot?.entitlement.state).toBe("ACTIVE");
    expect(data.snapshot?.usage.cycleOpened).toBe(false);
    // The panel is documented as read-only, and this is the assertion that makes it so.
    expect(await db().usageCycle.count({ where: { workspaceId: tenant.workspaceId } })).toBe(before);
  }, 300_000);

  it("says a tenant does not exist rather than failing", async () => {
    const data = await assembleAdminWorkspace(db(), support, "01a00000-0000-7000-8000-000000000000", BASE, NOW);

    expect(data.snapshot).toBeUndefined();
    expect(data.scope.refusal).toBe("NO_SESSION");
  }, 300_000);

  it("hides a customer's correspondence until a session grants it, and says which refusal applies", async () => {
    const conversation = await db().conversation.findFirst({ where: { workspaceId: tenant.workspaceId }, select: { id: true, businessProfileId: true } });
    const target = {
      workspaceId: tenant.workspaceId,
      businessProfileId: conversation?.businessProfileId ?? tenant.businessProfileId,
      conversationId: conversation?.id ?? "none",
    };

    const hidden = await assembleAdminConversation(db(), support, target, BASE, NOW);
    expect(hidden.lines).toBeUndefined();
    expect(hidden.refusal).toBe("NO_SESSION");

    const opened = await openSupportAccessSession(db(), support, {
      workspaceId: tenant.workspaceId,
      scopes: ["CONVERSATION_CONTENT"],
      reason: "ticket 9: checking what the customer was told",
      at: NOW,
    });
    const shown = await assembleAdminConversation(db(), support, target, BASE, NOW);
    expect(shown.refusal).toBeUndefined();
    expect(Array.isArray(shown.lines)).toBe(true);

    // Revoked: hidden again, and the refusal says what became of the session rather than that there was
    // never one — which is the difference between renewing and re-requesting.
    await revokeSupportAccessSession(db(), support, { sessionId: opened.sessionId, reason: "finished", at: NOW });
    const again = await assembleAdminConversation(db(), support, target, BASE, NOW);
    expect(again.lines).toBeUndefined();
    expect(again.refusal).toBe("REVOKED");
  }, 300_000);

  it("shows the internal audit, including the actions this suite just took", async () => {
    const data = await assembleAdminAudit(db(), support, {}, BASE);

    expect(data.rows.length).toBeGreaterThan(0);
    expect(data.rows.some((row) => row.kind === "SUPPORT_SESSION_OPENED")).toBe(true);
    expect(data.rows.some((row) => row.kind === "SUPPORT_SESSION_REVOKED")).toBe(true);
    // Every row names why, because a row without a reason is what the table exists to prevent.
    expect(data.rows.every((row) => row.reason.trim() !== "")).toBe(true);
  }, 300_000);

  it("pages the audit with both halves of the cursor, or neither", async () => {
    const first = await assembleAdminAudit(db(), support, {}, BASE);
    // Half a cursor is ignored rather than applied: an instant with no tiebreak silently repeats or
    // skips rows as new ones land.
    const halfCursor = await assembleAdminAudit(db(), support, { since: first.rows[0]?.occurredAt.toISOString() ?? "" }, BASE);

    expect(halfCursor.rows.map((row) => row.id)).toEqual(first.rows.map((row) => row.id));
  }, 300_000);
});
