/**
 * The audit log (Issue #34).
 *
 * The two cases that matter most are asserted against the database rather than against the store: append-
 * only is a trigger, and the sensitivity rule is a CHECK. Both therefore hold for a migration, a console
 * session and any code written after this file.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auditPageLimit, readableAuditKinds, recordAuditEvent, recordWorkspaceAuditEvent, searchAuditEvents } from "./audit-store";
import { addWorkspaceMember } from "./repositories/workspaces";
import { authorizeWorkspaceAccess } from "./tenancy";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { seedWorkspace, type SeededProfile, type SeededWorkspace } from "./testing/fixtures";

const AT = new Date("2026-10-01T12:00:00.000Z");
/** One second apart, so ordering is a fact about the data rather than about insertion speed. */
const at = (seconds: number) => new Date(AT.getTime() + seconds * 1000);

describe.skipIf(!databaseTestsEnabled())("the audit log", () => {
  let database: TestDatabase;
  let workspace: SeededWorkspace;
  let profile: SeededProfile;
  let second: SeededProfile;
  let neighbour: SeededWorkspace;
  let ownerContext: Awaited<ReturnType<typeof authorizeWorkspaceAccess>>;
  let agentContext: Awaited<ReturnType<typeof authorizeWorkspaceAccess>>;
  let narrowContext: Awaited<ReturnType<typeof authorizeWorkspaceAccess>>;
  let agentUserId: string;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    workspace = await seedWorkspace(database.db, "audit", ["main", "second"]);
    [profile, second] = workspace.profiles as [SeededProfile, SeededProfile];
    neighbour = await seedWorkspace(database.db, "audit-neighbour");

    ownerContext = await authorizeWorkspaceAccess(database.db, { userId: workspace.ownerUserId, workspaceId: workspace.workspaceId });

    const agent = await database.db.user.create({ data: { name: "Audit Agent", email: "audit-agent@example.test" } });
    agentUserId = agent.id;
    await addWorkspaceMember(database.db, ownerContext, { userId: agentUserId, role: "AGENT", businessProfileScope: "ALL" });
    agentContext = await authorizeWorkspaceAccess(database.db, { userId: agentUserId, workspaceId: workspace.workspaceId });

    // A member who may see one profile out of two, for the scope case.
    const narrow = await database.db.user.create({ data: { name: "Audit Narrow", email: "audit-narrow@example.test" } });
    await addWorkspaceMember(database.db, ownerContext, {
      userId: narrow.id,
      role: "ADMIN",
      businessProfileScope: { selected: [profile.businessProfileId] },
    });
    narrowContext = await authorizeWorkspaceAccess(database.db, { userId: narrow.id, workspaceId: workspace.workspaceId });
  }, 180_000);

  afterAll(async () => {
    await database?.dispose();
  });

  const db = () => database.db;

  describe("append-only, in the database", () => {
    it("refuses an update, however it is attempted", async () => {
      const { id } = await recordAuditEvent(db(), profile.context, {
        kind: "MODE_CHANGED",
        summary: "Switched to DRAFT",
        subjectType: "conversations",
        subjectId: profile.conversationId,
        actorUserId: workspace.ownerUserId,
        occurredAt: at(1),
      });

      // A comment asking people not to edit the log is not a mechanism. This is.
      await expect(db().auditEvent.update({ where: { id }, data: { summary: "Actually it was fine" } })).rejects.toThrow(/append-only/u);
      await expect(db().$executeRawUnsafe(`UPDATE "audit_events" SET "summary" = 'rewritten' WHERE "id" = $1::uuid`, id)).rejects.toThrow(
        /append-only/u,
      );
      expect((await db().auditEvent.findUnique({ where: { id }, select: { summary: true } }))?.summary).toBe("Switched to DRAFT");
    }, 180_000);

    it("refuses a delete, so history cannot be tidied", async () => {
      const { id } = await recordAuditEvent(db(), profile.context, {
        kind: "DRAFT_REJECTED",
        summary: "Rejected a draft about pricing",
        subjectType: "ai_drafts",
        subjectId: "draft-1",
        actorUserId: workspace.ownerUserId,
        occurredAt: at(2),
      });

      await expect(db().auditEvent.delete({ where: { id } })).rejects.toThrow(/append-only/u);
      await expect(db().$executeRawUnsafe(`DELETE FROM "audit_events" WHERE "id" = $1::uuid`, id)).rejects.toThrow(/append-only/u);
      expect(await db().auditEvent.count({ where: { id } })).toBe(1);
    }, 180_000);

    it("refuses a bulk update that would touch no row it was aiming at", async () => {
      // `updateMany` with a matching filter is the shape somebody reaches for when "fixing a typo in the
      // log", and it has to fail too.
      await expect(db().auditEvent.updateMany({ where: { workspaceId: workspace.workspaceId }, data: { sensitive: true } })).rejects.toThrow(
        /append-only/u,
      );
    }, 180_000);

    it("still accepts new rows, so the trigger is not refusing everything", async () => {
      const before = await db().auditEvent.count({ where: { workspaceId: workspace.workspaceId } });
      await recordAuditEvent(db(), profile.context, {
        kind: "STYLE_VERSIONED",
        summary: "Published a new voice",
        subjectType: "style_profiles",
        subjectId: "style-1",
        actorUserId: workspace.ownerUserId,
        occurredAt: at(3),
      });
      expect(await db().auditEvent.count({ where: { workspaceId: workspace.workspaceId } })).toBe(before + 1);
    }, 180_000);
  });

  describe("what the row must say", () => {
    it("names an actor exactly when there is one", async () => {
      const byPerson = await recordAuditEvent(db(), profile.context, {
        kind: "TAKEOVER_STARTED",
        summary: "Took the conversation over",
        subjectType: "conversations",
        subjectId: profile.conversationId,
        actorUserId: workspace.ownerUserId,
        occurredAt: at(4),
      });
      const bySystem = await recordAuditEvent(db(), profile.context, {
        kind: "AMBIGUOUS_SEND_RESOLVED",
        summary: "Reconciliation found the message had gone out",
        subjectType: "delivery_reconciliations",
        subjectId: "recon-1",
        occurredAt: at(5),
      });

      const rows = await db().auditEvent.findMany({ where: { id: { in: [byPerson.id, bySystem.id] } }, select: { id: true, actorKind: true, actorUserId: true } });
      expect(rows.find((row) => row.id === byPerson.id)).toMatchObject({ actorKind: "USER", actorUserId: workspace.ownerUserId });
      // Reconciliation acts without anybody asking. Putting a name against it would be a lie.
      expect(rows.find((row) => row.id === bySystem.id)).toMatchObject({ actorKind: "SYSTEM", actorUserId: null });
    }, 180_000);

    it("refuses a USER row with nobody named, and a SYSTEM row with somebody", async () => {
      const insert = (actorKind: string, actorUserId: string | null) =>
        db().$executeRawUnsafe(
          `INSERT INTO "audit_events" ("workspace_id","business_profile_id","kind","actor_kind","actor_user_id","summary","subject_type","subject_id")
           VALUES ($1,$2,'MODE_CHANGED',$3::"AuditActorKind",$4,'x','conversations','c')`,
          workspace.workspaceId,
          profile.businessProfileId,
          actorKind,
          actorUserId,
        );

      await expect(insert("USER", null)).rejects.toThrow(/audit_events_actor_check/u);
      await expect(insert("SYSTEM", workspace.ownerUserId)).rejects.toThrow(/audit_events_actor_check/u);
    }, 180_000);

    it("refuses a row with nothing written on it", async () => {
      const insert = (summary: string, subjectType: string, subjectId: string) =>
        db().$executeRawUnsafe(
          `INSERT INTO "audit_events" ("workspace_id","business_profile_id","kind","actor_kind","actor_user_id","summary","subject_type","subject_id")
           VALUES ($1,$2,'MODE_CHANGED','USER',$3,$4,$5,$6)`,
          workspace.workspaceId,
          profile.businessProfileId,
          workspace.ownerUserId,
          summary,
          subjectType,
          subjectId,
        );

      // An audit row that says nothing appears in a search as a thing that happened and tells the reader
      // nothing, which is worse than no row at all.
      await expect(insert("   ", "conversations", "c")).rejects.toThrow(/audit_events_summary_check/u);
      await expect(insert("x", " ", "c")).rejects.toThrow(/audit_events_subject_check/u);
      await expect(insert("x", "conversations", "")).rejects.toThrow(/audit_events_subject_check/u);
    }, 180_000);

    it("will not let a membership or channel change be filed as ordinary work", async () => {
      const insert = (kind: string, sensitive: boolean, profileId: string | null) =>
        db().$executeRawUnsafe(
          `INSERT INTO "audit_events" ("workspace_id","business_profile_id","kind","actor_kind","actor_user_id","summary","subject_type","subject_id","sensitive")
           VALUES ($1,$2,$3::"AuditEventKind",'USER',$4,'x','y','z',$5)`,
          workspace.workspaceId,
          profileId,
          kind,
          workspace.ownerUserId,
          sensitive,
        );

      // The CHECK, not the store, is what makes this impossible to get wrong in a hurry.
      await expect(insert("MEMBER_CHANGED", false, null)).rejects.toThrow(/audit_events_sensitivity_check/u);
      await expect(insert("CHANNEL_CONNECTED", false, profile.businessProfileId)).rejects.toThrow(/audit_events_sensitivity_check/u);
      await expect(insert("CHANNEL_DISCONNECTED", false, profile.businessProfileId)).rejects.toThrow(/audit_events_sensitivity_check/u);
      await expect(insert("MODE_CHANGED", false, profile.businessProfileId)).resolves.toBeGreaterThan(0);
    }, 180_000);

    it("keeps a membership change at the workspace, and everything else in a profile", async () => {
      const insert = (kind: string, profileId: string | null) =>
        db().$executeRawUnsafe(
          `INSERT INTO "audit_events" ("workspace_id","business_profile_id","kind","actor_kind","actor_user_id","summary","subject_type","subject_id","sensitive")
           VALUES ($1,$2,$3::"AuditEventKind",'USER',$4,'x','y','z',TRUE)`,
          workspace.workspaceId,
          profileId,
          kind,
          workspace.ownerUserId,
        );

      // Filing a role change under one profile would hide it from the workspace view, which is the only
      // place it makes sense to read.
      await expect(insert("MEMBER_CHANGED", profile.businessProfileId)).rejects.toThrow(/audit_events_scope_check/u);
      await expect(insert("CHANNEL_CONNECTED", null)).rejects.toThrow(/audit_events_scope_check/u);
    }, 180_000);

    it("derives sensitivity rather than taking the caller's word", async () => {
      const { id } = await recordWorkspaceAuditEvent(db(), ownerContext, {
        kind: "MEMBER_CHANGED",
        summary: "Made Audit Agent an admin",
        subjectType: "workspace_members",
        subjectId: agentUserId,
        actorUserId: workspace.ownerUserId,
        occurredAt: at(6),
      });

      // There is no `sensitive` on the input at all: the only way to mark something sensitive is to give
      // it a kind that is. A caller who could choose would eventually file a role change as ordinary work
      // in a hurry, the CHECK would reject the insert, and the actual change would go down with it.
      expect((await db().auditEvent.findUnique({ where: { id }, select: { sensitive: true } }))?.sensitive).toBe(true);
    }, 180_000);

    it("outlives what it describes", async () => {
      const { id } = await recordAuditEvent(db(), profile.context, {
        kind: "KNOWLEDGE_VERSIONED",
        summary: "Replaced the opening hours document",
        subjectType: "knowledge_documents",
        subjectId: "a-document-that-will-be-deleted",
        actorUserId: workspace.ownerUserId,
        occurredAt: at(7),
      });

      // `subject_id` is deliberately not a foreign key. An audit row whose subject was deleted is exactly
      // the row somebody needs, and a cascade would remove the evidence along with the thing.
      expect((await db().auditEvent.findUnique({ where: { id }, select: { subjectId: true } }))?.subjectId).toBe("a-document-that-will-be-deleted");
    }, 180_000);
  });

  describe("who may read what", () => {
    beforeAll(async () => {
      await recordWorkspaceAuditEvent(db(), ownerContext, {
        kind: "MEMBER_CHANGED",
        summary: "Granted access to the second profile",
        subjectType: "workspace_members",
        subjectId: agentUserId,
        actorUserId: workspace.ownerUserId,
        occurredAt: at(20),
      });
      await recordAuditEvent(db(), profile.context, {
        kind: "CHANNEL_CONNECTED",
        summary: "Connected an Instagram account",
        subjectType: "channel_accounts",
        subjectId: profile.channelAccount.id,
        actorUserId: workspace.ownerUserId,
        channelAccountId: profile.channelAccount.id,
        occurredAt: at(21),
      });
      await recordAuditEvent(db(), profile.context, {
        kind: "POLICY_CHANGED",
        summary: "Raised the confidence threshold",
        subjectType: "automation_policies",
        subjectId: "policy-1",
        actorUserId: workspace.ownerUserId,
        occurredAt: at(22),
      });
    });

    it("shows an admin everything, including the sensitive kinds", async () => {
      const page = await searchAuditEvents(db(), ownerContext, { limit: 200 });

      expect(page.rows.some((row) => row.kind === "MEMBER_CHANGED")).toBe(true);
      expect(page.rows.some((row) => row.kind === "CHANNEL_CONNECTED")).toBe(true);
      expect(page.restricted).toBe(false);
    }, 180_000);

    it("does not tell an Agent that sensitive rows exist", async () => {
      const page = await searchAuditEvents(db(), agentContext, { limit: 200 });

      // Absent, not redacted. A row shown as `***` at 14:02 still discloses that somebody's access
      // changed at 14:02, which is most of what was being withheld.
      expect(page.rows.some((row) => row.sensitive)).toBe(false);
      expect(page.rows.some((row) => row.kind === "MEMBER_CHANGED")).toBe(false);
      expect(page.rows.some((row) => row.kind === "CHANNEL_CONNECTED")).toBe(false);
      // The ordinary work is still there, so this is a filter rather than a blank page.
      expect(page.rows.some((row) => row.kind === "POLICY_CHANGED")).toBe(true);
      expect(page.restricted).toBe(true);
    }, 180_000);

    it("gives an Agent who asks for a sensitive kind the kinds they may see, not an error", async () => {
      const page = await searchAuditEvents(db(), agentContext, { kinds: ["MEMBER_CHANGED", "POLICY_CHANGED"], limit: 200 });

      expect(page.rows.every((row) => row.kind === "POLICY_CHANGED")).toBe(true);
      expect(page.restricted).toBe(true);
    }, 180_000);

    it("asks a narrower question for an Agent rather than filtering the answer", async () => {
      // The page size has to come back full. Fetching sensitive rows and dropping them afterwards would
      // return four rows for a page of ten, which tells the reader exactly how many were hidden.
      for (let index = 0; index < 12; index += 1) {
        await recordWorkspaceAuditEvent(db(), ownerContext, {
          kind: "MEMBER_CHANGED",
          summary: `Changed a role, round ${String(index)}`,
          subjectType: "workspace_members",
          subjectId: agentUserId,
          actorUserId: workspace.ownerUserId,
          occurredAt: at(100 + index),
        });
        await recordAuditEvent(db(), profile.context, {
          kind: "MODE_CHANGED",
          summary: `Changed the mode, round ${String(index)}`,
          subjectType: "conversations",
          subjectId: profile.conversationId,
          actorUserId: workspace.ownerUserId,
          occurredAt: at(200 + index),
        });
      }

      const page = await searchAuditEvents(db(), agentContext, { limit: 10 });

      expect(page.rows).toHaveLength(10);
      expect(page.rows.every((row) => !row.sensitive)).toBe(true);
    }, 180_000);

    it("offers only the kinds a reader may filter by", () => {
      expect(readableAuditKinds(ownerContext)).toContain("MEMBER_CHANGED");
      expect(readableAuditKinds(agentContext)).not.toContain("MEMBER_CHANGED");
      expect(readableAuditKinds(agentContext)).not.toContain("CHANNEL_CONNECTED");
      expect(readableAuditKinds(agentContext)).toContain("POLICY_CHANGED");
    });

    it("keeps a member to the Business Profiles they may see, but still shows workspace actions", async () => {
      await recordAuditEvent(db(), second.context, {
        kind: "MODE_CHANGED",
        summary: "Changed the mode in the other profile",
        subjectType: "conversations",
        subjectId: second.conversationId,
        actorUserId: workspace.ownerUserId,
        occurredAt: at(300),
      });

      const page = await searchAuditEvents(db(), narrowContext, { limit: 200 });

      expect(page.rows.some((row) => row.businessProfileId === second.businessProfileId)).toBe(false);
      expect(page.rows.some((row) => row.businessProfileId === profile.businessProfileId)).toBe(true);
      // A membership change is not customer data and belongs to no profile; hiding it from a SELECTED
      // admin would hide the record of their own access being granted.
      expect(page.rows.some((row) => row.kind === "MEMBER_CHANGED")).toBe(true);
    }, 180_000);

    it("never shows another Workspace's log", async () => {
      const [theirProfile] = neighbour.profiles as [SeededProfile];
      await recordAuditEvent(db(), theirProfile.context, {
        kind: "POLICY_CHANGED",
        summary: "Their own policy change",
        subjectType: "automation_policies",
        subjectId: "their-policy",
        actorUserId: neighbour.ownerUserId,
        occurredAt: at(400),
      });

      const page = await searchAuditEvents(db(), ownerContext, { term: "Their own", limit: 200 });

      expect(page.rows).toEqual([]);
    }, 180_000);
  });

  describe("searching it", () => {
    it("matches the words somebody remembers typing, case-insensitively", async () => {
      await recordAuditEvent(db(), profile.context, {
        kind: "DRAFT_EDITED",
        summary: "Edited a reply about the Saturday opening hours",
        subjectType: "ai_drafts",
        subjectId: "draft-saturday",
        actorUserId: workspace.ownerUserId,
        occurredAt: at(500),
      });

      expect((await searchAuditEvents(db(), ownerContext, { term: "saturday" })).rows.some((row) => row.subjectId === "draft-saturday")).toBe(true);
      expect((await searchAuditEvents(db(), ownerContext, { term: "SATURDAY OPENING" })).rows.some((row) => row.subjectId === "draft-saturday")).toBe(true);
      expect((await searchAuditEvents(db(), ownerContext, { term: "tuesday" })).rows.some((row) => row.subjectId === "draft-saturday")).toBe(false);
    }, 180_000);

    it("combines filters rather than choosing between them", async () => {
      await recordAuditEvent(db(), profile.context, {
        kind: "TAKEOVER_ENDED",
        summary: "Handed a combined-filter conversation back",
        subjectType: "conversations",
        subjectId: profile.conversationId,
        actorUserId: agentUserId,
        channelAccountId: profile.channelAccount.id,
        conversationId: profile.conversationId,
        occurredAt: at(600),
      });

      const hits = await searchAuditEvents(db(), ownerContext, {
        kinds: ["TAKEOVER_ENDED"],
        businessProfileId: profile.businessProfileId,
        channelAccountId: profile.channelAccount.id,
        conversationId: profile.conversationId,
        actorUserId: agentUserId,
        term: "combined-filter",
        from: at(599),
        to: at(601),
        limit: 50,
      });

      expect(hits.rows).toHaveLength(1);
      expect(hits.rows[0]?.actorName).toBe("Audit Agent");
    }, 180_000);

    it("excludes a row on the exclusive end of the range and includes one on the inclusive start", async () => {
      await recordAuditEvent(db(), profile.context, {
        kind: "MODE_CHANGED",
        summary: "Boundary row exactly on the start",
        subjectType: "conversations",
        subjectId: "boundary-start",
        actorUserId: workspace.ownerUserId,
        occurredAt: at(700),
      });
      await recordAuditEvent(db(), profile.context, {
        kind: "MODE_CHANGED",
        summary: "Boundary row exactly on the end",
        subjectType: "conversations",
        subjectId: "boundary-end",
        actorUserId: workspace.ownerUserId,
        occurredAt: at(701),
      });

      const ids = (await searchAuditEvents(db(), ownerContext, { from: at(700), to: at(701), limit: 50 })).rows.map((row) => row.subjectId);

      // `from` inclusive and `to` exclusive is the only pair that lets adjacent ranges tile without
      // counting the boundary twice.
      expect(ids).toContain("boundary-start");
      expect(ids).not.toContain("boundary-end");
    }, 180_000);

    it("pages newest first and offers a cursor only when there is another page", async () => {
      const all = await searchAuditEvents(db(), ownerContext, { limit: 200 });
      expect(all.rows.length).toBeGreaterThan(5);
      // Newest first, so the page a reader lands on is the one they want.
      for (let index = 1; index < all.rows.length; index += 1) {
        const previous = all.rows[index - 1]?.occurredAt.getTime() ?? 0;
        expect(all.rows[index]?.occurredAt.getTime() ?? 0).toBeLessThanOrEqual(previous);
      }
      expect(all.nextCursor).toBeUndefined();

      const first = await searchAuditEvents(db(), ownerContext, { limit: 3 });
      expect(first.rows).toHaveLength(3);
      expect(first.nextCursor).toBeDefined();
      const next = await searchAuditEvents(db(), ownerContext, { limit: 3, ...(first.nextCursor === undefined ? {} : { cursor: first.nextCursor }) });
      // No overlap and no gap: the cursor is the last row of the page, not its count.
      expect(next.rows.map((row) => row.id)).not.toContain(first.rows[2]?.id);
      expect(first.rows.map((row) => row.id)).not.toContain(next.rows[0]?.id);
    }, 180_000);

    it("does not offer a cursor when the last page happens to be exactly full", async () => {
      const total = (await searchAuditEvents(db(), ownerContext, { limit: 200 })).rows.length;

      const exact = await searchAuditEvents(db(), ownerContext, { limit: total });

      // Reading one more row than asked is what makes this answerable. Offering a cursor because the page
      // filled would give the reader a "load older" link that loads nothing.
      expect(exact.rows).toHaveLength(total);
      expect(exact.nextCursor).toBeUndefined();
    }, 180_000);

    it("clamps a nonsense page size", () => {
      expect(auditPageLimit(50)).toBe(50);
      expect(auditPageLimit(0)).toBe(1);
      expect(auditPageLimit(-3)).toBe(1);
      expect(auditPageLimit(10_000)).toBe(200);
      expect(auditPageLimit(Number.NaN)).toBe(50);
    });
  });
});
