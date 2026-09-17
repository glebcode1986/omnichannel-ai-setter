import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  addWorkspaceMember,
  appendInboundMessage,
  authorizeWorkspaceAccess,
  createChannelAccount,
  createContactWithIdentity,
  createConversation,
  getChannelAccount,
  getConversation,
  listChannelAccounts,
  listConversationMessages,
  listInboxConversations,
  listWorkspacesForUser,
  setConversationLeadStage,
  TenantRecordNotFoundError,
  WorkspaceAccessDeniedError,
  WorkspacePermissionError,
  type WorkspaceContext,
} from "./index";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { addTestMember, createTestUser, seedWorkspace, type SeededWorkspace } from "./testing/fixtures";

describe.skipIf(!databaseTestsEnabled())("workspace isolation (PostgreSQL)", () => {
  let database: TestDatabase;
  let a: SeededWorkspace;
  let b: SeededWorkspace;
  const db = () => database.db;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    a = await seedWorkspace(database.db, "a");
    b = await seedWorkspace(database.db, "b");
  }, 120_000);

  afterAll(async () => {
    await database?.dispose();
  });

  describe("authorization", () => {
    it("issues a context only for a member of the explicitly requested workspace", async () => {
      const own = await authorizeWorkspaceAccess(db(), { userId: a.ownerUserId, workspaceId: a.context.workspaceId });
      expect(own).toMatchObject({ workspaceId: a.context.workspaceId, role: "OWNER" });

      for (const request of [
        { userId: a.ownerUserId, workspaceId: b.context.workspaceId },
        { userId: a.ownerUserId, workspaceId: "00000000-0000-7000-8000-000000000000" },
        { userId: "unknown-user", workspaceId: a.context.workspaceId },
      ]) {
        await expect(authorizeWorkspaceAccess(db(), request)).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
      }
    });

    it("supports one user in several workspaces with independent roles and data", async () => {
      const userId = await createTestUser(db(), "multi");
      const inA = await addTestMember(db(), a.context.workspaceId, userId, "AGENT");
      const inB = await addTestMember(db(), b.context.workspaceId, userId, "ADMIN");

      expect([inA.role, inB.role]).toEqual(["AGENT", "ADMIN"]);
      expect(await listWorkspacesForUser(db(), userId)).toEqual([
        { workspaceId: a.context.workspaceId, name: "Workspace a", role: "AGENT" },
        { workspaceId: b.context.workspaceId, name: "Workspace b", role: "ADMIN" },
      ]);
      expect((await listInboxConversations(db(), inA)).map((conversation) => conversation.id)).toEqual([a.conversationId]);
      expect((await listInboxConversations(db(), inB)).map((conversation) => conversation.id)).toEqual([b.conversationId]);
    });

    it("rejects forged contexts at every repository entry point without writing", async () => {
      const forgedContexts = [
        { ...a.context },
        { workspaceId: b.context.workspaceId, userId: a.ownerUserId, role: "OWNER" },
      ] as unknown as WorkspaceContext[];

      for (const forged of forgedContexts) {
        const attempts: Promise<unknown>[] = [
          getConversation(db(), forged, b.conversationId),
          listInboxConversations(db(), forged),
          setConversationLeadStage(db(), forged, b.conversationId, "LOST"),
          appendInboundMessage(db(), forged, { conversationId: b.conversationId, kind: "TEXT", occurredAt: new Date() }),
          listConversationMessages(db(), forged, b.conversationId),
          getChannelAccount(db(), forged, b.channelAccount.id),
          listChannelAccounts(db(), forged),
          createChannelAccount(db(), forged, {
            channel: "WHATSAPP",
            externalAccountId: "forged-account",
            capabilities: b.channelAccount.capabilities as never,
          }),
          createContactWithIdentity(db(), forged, { channelAccountId: b.channelAccount.id, externalUserId: "forged" }),
          createConversation(db(), forged, { channelAccountId: b.channelAccount.id, contactIdentityId: b.contactIdentityId }),
          addWorkspaceMember(db(), forged, { userId: a.ownerUserId, role: "OWNER" }),
        ];
        for (const attempt of attempts) {
          await expect(attempt).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
        }
      }

      expect((await getConversation(db(), b.context, b.conversationId))?.leadStage).toBe("NEW");
      expect(await listConversationMessages(db(), b.context, b.conversationId)).toHaveLength(1);
      expect(await db().workspaceMember.count({ where: { workspaceId: b.context.workspaceId, userId: a.ownerUserId } })).toBe(0);
    });

    it("stops authorizing as soon as membership is removed", async () => {
      const userId = await createTestUser(db(), "revoked");
      await addTestMember(db(), a.context.workspaceId, userId, "AGENT");
      await db().workspaceMember.delete({
        where: { workspaceId_userId: { workspaceId: a.context.workspaceId, userId } },
      });

      await expect(authorizeWorkspaceAccess(db(), { userId, workspaceId: a.context.workspaceId })).rejects.toBeInstanceOf(
        WorkspaceAccessDeniedError,
      );
    });

    it("enforces roles for administrative operations", async () => {
      const agent = await addTestMember(db(), a.context.workspaceId, await createTestUser(db(), "agent"), "AGENT");
      const admin = await addTestMember(db(), a.context.workspaceId, await createTestUser(db(), "admin"), "ADMIN");
      const newcomer = await createTestUser(db(), "newcomer");

      await expect(
        createChannelAccount(db(), agent, { channel: "WHATSAPP", externalAccountId: "wa-agent", capabilities: a.channelAccount.capabilities as never }),
      ).rejects.toBeInstanceOf(WorkspacePermissionError);
      await expect(addWorkspaceMember(db(), agent, { userId: newcomer, role: "AGENT" })).rejects.toBeInstanceOf(WorkspacePermissionError);
      await expect(addWorkspaceMember(db(), admin, { userId: newcomer, role: "OWNER" })).rejects.toBeInstanceOf(WorkspacePermissionError);

      await addWorkspaceMember(db(), admin, { userId: newcomer, role: "AGENT" });
      expect((await authorizeWorkspaceAccess(db(), { userId: newcomer, workspaceId: a.context.workspaceId })).role).toBe("AGENT");
    });
  });

  describe("cross-workspace reads", () => {
    it("never return another workspace's records", async () => {
      expect(await getConversation(db(), a.context, b.conversationId)).toBeNull();
      expect(await getChannelAccount(db(), a.context, b.channelAccount.id)).toBeNull();
      expect((await listInboxConversations(db(), a.context)).map((conversation) => conversation.id)).toEqual([a.conversationId]);
      expect(await listInboxConversations(db(), a.context, { channelAccountId: b.channelAccount.id })).toEqual([]);
      expect((await listChannelAccounts(db(), a.context)).map((account) => account.id)).toEqual([a.channelAccount.id]);
      await expect(listConversationMessages(db(), a.context, b.conversationId)).rejects.toBeInstanceOf(TenantRecordNotFoundError);

      expect(await getConversation(db(), a.context, a.conversationId)).not.toBeNull();
      expect(await listConversationMessages(db(), a.context, a.conversationId)).toHaveLength(1);
    });
  });

  describe("cross-workspace writes", () => {
    it("cannot update another workspace's conversation", async () => {
      await expect(setConversationLeadStage(db(), a.context, b.conversationId, "LOST")).rejects.toBeInstanceOf(
        TenantRecordNotFoundError,
      );
      expect((await getConversation(db(), b.context, b.conversationId))?.leadStage).toBe("NEW");

      const updated = await setConversationLeadStage(db(), a.context, a.conversationId, "ENGAGED");
      expect(updated.leadStage).toBe("ENGAGED");
    });

    it("cannot append messages to another workspace's conversation", async () => {
      await expect(
        appendInboundMessage(db(), a.context, { conversationId: b.conversationId, kind: "TEXT", text: "intrusion", occurredAt: new Date() }),
      ).rejects.toBeInstanceOf(TenantRecordNotFoundError);
      expect(await listConversationMessages(db(), b.context, b.conversationId)).toHaveLength(1);
    });

    it("cannot attach contacts or conversations to another workspace's records", async () => {
      const contactsBefore = await db().contact.count();
      const conversationsBefore = await db().conversation.count();

      await expect(
        createContactWithIdentity(db(), a.context, { channelAccountId: b.channelAccount.id, externalUserId: "intruder" }),
      ).rejects.toBeInstanceOf(TenantRecordNotFoundError);
      await expect(
        createConversation(db(), a.context, { channelAccountId: b.channelAccount.id, contactIdentityId: b.contactIdentityId }),
      ).rejects.toBeInstanceOf(TenantRecordNotFoundError);
      await expect(
        createConversation(db(), a.context, { channelAccountId: a.channelAccount.id, contactIdentityId: b.contactIdentityId }),
      ).rejects.toBeInstanceOf(TenantRecordNotFoundError);

      expect(await db().contact.count()).toBe(contactsBefore);
      expect(await db().conversation.count()).toBe(conversationsBefore);
    });

    it("is rejected by composite foreign keys even when repositories are bypassed", async () => {
      await expect(
        db().message.create({
          data: {
            workspaceId: a.context.workspaceId,
            channelAccountId: b.channelAccount.id,
            conversationId: b.conversationId,
            direction: "IN",
            source: "PARTICIPANT",
            kind: "TEXT",
            occurredAt: new Date(),
          },
        }),
      ).rejects.toMatchObject({ code: "P2003" });
      await expect(
        db().contactIdentity.create({
          data: { workspaceId: a.context.workspaceId, contactId: a.contactId, channelAccountId: b.channelAccount.id, externalUserId: "x" },
        }),
      ).rejects.toMatchObject({ code: "P2003" });
      // Tenant ownership cannot be moved: children reference (workspace_id, id) with ON UPDATE RESTRICT.
      await expect(
        db().conversation.update({ where: { id: b.conversationId }, data: { workspaceId: a.context.workspaceId } }),
      ).rejects.toThrow();
      expect((await db().conversation.findUniqueOrThrow({ where: { id: b.conversationId } })).workspaceId).toBe(
        b.context.workspaceId,
      );
    });
  });
});
