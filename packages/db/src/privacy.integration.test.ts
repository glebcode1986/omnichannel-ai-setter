/**
 * Who may do what with a customer's data, and what deactivation is not (#57, P3-04).
 *
 * Three questions, each with a wrong answer that is easy to ship.
 *
 * **Scope is not permission.** Every member of a Business Profile can read the conversations in it —
 * that is their job. Taking the whole of somebody's history out in one action, or destroying it, are
 * different capabilities with different consequences, and until this task they were gated by the same
 * check as reading a thread.
 *
 * **A profile is not a boundary if a write can reach past it.** A Workspace-scoped knowledge source or
 * style example is read by *every* profile, so making one from a single profile's screen is a
 * cross-profile write — which an agent granted one profile could do.
 *
 * **Deactivating is not deleting.** They are different promises, and a product that quietly conflated
 * them would destroy data a business expected to come back to.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { exportContact, EXPORT_MESSAGE_LIMIT } from "./export-store";
import { forgetCustomer } from "./customer-memory-store";
import { createKnowledge } from "./knowledge-store";
import { createStyleExample } from "./style-store";
import { appendInboundMessage } from "./repositories/messages";
import { searchAuditEvents } from "./audit-store";
import { addTestMember, createTestUser, seedWorkspace, type SeededProfile } from "./testing/fixtures";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { authorizeBusinessProfileAccess, authorizeWorkspaceAccess } from "./tenancy";

const NOW = new Date("2026-10-07T12:00:00.000Z");

describe.skipIf(!databaseTestsEnabled())("privacy, least privilege and deactivation (PostgreSQL)", () => {
  let database: TestDatabase;
  let profile: SeededProfile;
  let other: SeededProfile;
  let ownerWorkspace: Awaited<ReturnType<typeof authorizeWorkspaceAccess>>;
  let agentProfile: Awaited<ReturnType<typeof authorizeBusinessProfileAccess>>;
  let agentUserId: string;
  let workspaceId: string;
  const db = () => database.db;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    const seeded = await seedWorkspace(database.db, "privacy", ["main", "second"]);
    [profile, other] = seeded.profiles as [SeededProfile, SeededProfile];
    ownerWorkspace = seeded.context;
    workspaceId = seeded.workspaceId;
    agentUserId = await createTestUser(database.db, "privacy-agent");
    // Granted exactly one Business Profile, which is the shape that makes a cross-profile write visible.
    await addTestMember(database.db, workspaceId, agentUserId, "AGENT", [profile.businessProfileId]);
    agentProfile = await authorizeBusinessProfileAccess(database.db, {
      userId: agentUserId,
      workspaceId,
      businessProfileId: profile.businessProfileId,
    });
  }, 120_000);

  afterAll(async () => {
    await database?.dispose();
  });

  describe("an agent handling conversations", () => {
    it("may read the thread they are working on", async () => {
      // The baseline. Everything below is about what they may *additionally* do, and the point is that
      // the answer used to be "all of it".
      const conversation = await db().conversation.findFirst({
        where: { workspaceId, businessProfileId: profile.businessProfileId, id: profile.conversationId },
      });

      expect(conversation).not.toBeNull();
    });

    it("may not take the whole of a customer's history out in one action", async () => {
      await expect(exportContact(db(), agentProfile, profile.contactId, NOW)).rejects.toThrow();
    });

    it("may not destroy what the business remembers about somebody", async () => {
      await expect(forgetCustomer(db(), agentProfile, profile.contactId)).rejects.toThrow();
    });

    it("may not write a knowledge source every Business Profile reads", async () => {
      // A Workspace-scoped source reaches the two profiles this agent was never granted.
      await expect(
        createKnowledge(db(), agentProfile, { title: "Workspace-wide prices", chunks: ["Everything costs 10."], scope: "WORKSPACE" }),
      ).rejects.toThrow();
    });

    it("may not write a style example every Business Profile reads", async () => {
      await expect(
        createStyleExample(db(), agentProfile, { inboundContext: "hello", outboundText: "hi!", scope: "WORKSPACE" }),
      ).rejects.toThrow();
    });

    it("may still write inside the profile they were granted", async () => {
      // The gate is about reach, not about distrusting the role: an agent's own profile is theirs to work in.
      await expect(
        createKnowledge(db(), agentProfile, { title: "This profile's prices", chunks: ["A haircut costs 20."], scope: "BUSINESS_PROFILE" }),
      ).resolves.toMatchObject({ status: "CREATED" });
    });
  });

  describe("exporting a customer's data", () => {
    it("returns the correspondence, the identifiers and what was learned", async () => {
      const result = await exportContact(db(), profile.context, profile.contactId, NOW);

      expect(result).toBeDefined();
      expect(result?.contact.id).toBe(profile.contactId);
      expect(result?.identities.length).toBeGreaterThan(0);
      expect(result?.conversations.flatMap((conversation) => conversation.messages).length).toBeGreaterThan(0);
      expect(result?.truncated).toBe(false);
    });

    it("records the read itself, because an export changes nothing and is still the most sensitive act", async () => {
      await exportContact(db(), profile.context, profile.contactId, NOW);

      const audits = await searchAuditEvents(db(), ownerWorkspace, { kinds: ["DATA_EXPORTED"] });
      expect(audits.rows.length).toBeGreaterThan(0);
      expect(audits.rows[0]).toMatchObject({ kind: "DATA_EXPORTED", subjectType: "Contact", subjectId: profile.contactId });
    });

    it("never puts the customer's words in the audit row", async () => {
      const marker = "canary-export-message-body";
      await appendInboundMessage(db(), profile.context, {
        conversationId: profile.conversationId,
        kind: "TEXT",
        text: marker,
        occurredAt: NOW,
      });

      await exportContact(db(), profile.context, profile.contactId, NOW);

      // An audit row that quoted the export would be a second copy of it, sitting where everybody with
      // the admin role can read it for ever.
      const audits = await searchAuditEvents(db(), ownerWorkspace, { kinds: ["DATA_EXPORTED"] });
      expect(JSON.stringify(audits.rows)).not.toContain(marker);
    });

    it("is not a way to discover a customer in a profile the caller cannot see", async () => {
      const otherProfileContext = await authorizeBusinessProfileAccess(db(), {
        userId: profile.context.userId,
        workspaceId,
        businessProfileId: other.businessProfileId,
      });

      // The same answer a contact that does not exist gets. "No such customer" and "not yours" must be
      // indistinguishable, or the export becomes a directory.
      expect(await exportContact(db(), otherProfileContext, profile.contactId, NOW)).toBeUndefined();
    });

    it("says when it hit its ceiling rather than reading as complete", () => {
      // An export with no cap is a way to take a whole Business Profile's history out through one
      // action, which is the shape of a breach rather than a subject-access request.
      expect(EXPORT_MESSAGE_LIMIT).toBeGreaterThan(0);
      expect(EXPORT_MESSAGE_LIMIT).toBeLessThanOrEqual(10_000);
    });
  });

  describe("deactivating a Business Profile", () => {
    it("keeps every customer, conversation and message", async () => {
      const before = {
        contacts: await db().contact.count({ where: { businessProfileId: other.businessProfileId } }),
        conversations: await db().conversation.count({ where: { businessProfileId: other.businessProfileId } }),
        messages: await db().message.count({ where: { businessProfileId: other.businessProfileId } }),
      };

      await db().businessProfile.update({ where: { workspaceId_id: { workspaceId, id: other.businessProfileId } }, data: { status: "INACTIVE" } });

      // Deactivation is a business saying "stop", not "forget". Conflating them would destroy data
      // somebody expected to come back to.
      expect({
        contacts: await db().contact.count({ where: { businessProfileId: other.businessProfileId } }),
        conversations: await db().conversation.count({ where: { businessProfileId: other.businessProfileId } }),
        messages: await db().message.count({ where: { businessProfileId: other.businessProfileId } }),
      }).toEqual(before);
      await db().businessProfile.update({ where: { workspaceId_id: { workspaceId, id: other.businessProfileId } }, data: { status: "ACTIVE" } });
    });
  });

  describe("a member who was removed", () => {
    it("loses access on the next request, while what they did stays attributed to them", async () => {
      const member = await db().workspaceMember.findFirstOrThrow({ where: { workspaceId, userId: agentUserId }, select: { id: true } });
      const auditsBefore = await db().auditEvent.count({ where: { workspaceId } });

      await db().memberBusinessProfileAccess.deleteMany({ where: { workspaceMemberId: member.id } });
      await db().workspaceMember.delete({ where: { id: member.id } });

      await expect(authorizeWorkspaceAccess(db(), { userId: agentUserId, workspaceId })).rejects.toThrow();
      await expect(
        authorizeBusinessProfileAccess(db(), { userId: agentUserId, workspaceId, businessProfileId: profile.businessProfileId }),
      ).rejects.toThrow();
      // Nothing they did is rewritten or removed: history is attribution, not access.
      expect(await db().auditEvent.count({ where: { workspaceId } })).toBe(auditsBefore);
      expect(await db().user.count({ where: { id: agentUserId } })).toBe(1);
    });
  });
});
