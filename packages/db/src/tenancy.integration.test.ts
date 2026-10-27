import { NO_CAPABILITIES } from "@omnichannel/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  addWorkspaceMember,
  appendInboundMessage,
  authorizeBusinessProfileAccess,
  authorizeWorkspaceAccess,
  BusinessProfileAccessDeniedError,
  createBusinessProfile,
  createChannelAccount,
  createContactWithChannelIdentity,
  createConversation,
  getChannelAccount,
  getConversation,
  listAuthorizedBusinessProfiles,
  listChannelAccounts,
  listInboxConversations,
  listWorkspacesForUser,
  setConversationLeadStage,
  TenantRecordNotFoundError,
  WorkspaceAccessDeniedError,
  WorkspacePermissionError,
  type BusinessProfileContext,
  type WorkspaceContext,
} from "./index";
import { readConversation } from "./inbox-store";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";
import { addTestMember, createTestUser, seedWorkspace, type SeededProfile, type SeededWorkspace } from "./testing/fixtures";

const MISSING_ID = "00000000-0000-7000-8000-000000000000";

describe.skipIf(!databaseTestsEnabled())("Workspace and Business Profile isolation (PostgreSQL)", () => {
  let database: TestDatabase;
  /** Workspace A with Business Profiles p1 and p2 (same provider user ID in both). */
  let a: SeededWorkspace;
  /** Workspace B with one Business Profile. */
  let b: SeededWorkspace;
  let a1: SeededProfile;
  let a2: SeededProfile;
  let b1: SeededProfile;
  let label = 0;
  const db = () => database.db;
  const nextLabel = (prefix: string) => `${prefix}-${++label}`;

  const profileContext = (userId: string, workspaceId: string, businessProfileId: string) =>
    authorizeBusinessProfileAccess(db(), { userId, workspaceId, businessProfileId });

  const memberInA = async (role: "ADMIN" | "AGENT", scope: "ALL" | readonly string[]) => {
    const userId = await createTestUser(db(), nextLabel(`a-${role.toLowerCase()}`));
    const context = await addTestMember(db(), a.workspaceId, userId, role, scope);
    return { userId, context };
  };

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
    a = await seedWorkspace(database.db, "a", ["p1", "p2"]);
    b = await seedWorkspace(database.db, "b", ["p1"]);
    [a1, a2] = a.profiles as [SeededProfile, SeededProfile];
    [b1] = b.profiles as [SeededProfile];
  }, 120_000);

  afterAll(async () => {
    await database?.dispose();
  });

  describe("authorization", () => {
    it("issues Workspace contexts only to members of the explicitly requested Workspace", async () => {
      expect(await authorizeWorkspaceAccess(db(), { userId: a.ownerUserId, workspaceId: a.workspaceId })).toMatchObject({
        role: "OWNER",
        businessProfileScope: { kind: "ALL" },
      });
      for (const request of [
        { userId: a.ownerUserId, workspaceId: b.workspaceId },
        { userId: a.ownerUserId, workspaceId: MISSING_ID },
        { userId: "unknown-user", workspaceId: a.workspaceId },
      ]) {
        await expect(authorizeWorkspaceAccess(db(), request)).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
      }
    });

    it("authorizes Business Profiles by scope and makes unauthorized profiles indistinguishable from missing ones", async () => {
      const selectedAdmin = await memberInA("ADMIN", [a1.businessProfileId]);
      const selectedAgent = await memberInA("AGENT", [a1.businessProfileId]);
      const noGrants = await memberInA("AGENT", []);

      for (const member of [selectedAdmin, selectedAgent]) {
        await expect(profileContext(member.userId, a.workspaceId, a1.businessProfileId)).resolves.toMatchObject({
          businessProfileId: a1.businessProfileId,
        });
        for (const businessProfileId of [a2.businessProfileId, b1.businessProfileId, MISSING_ID]) {
          await expect(profileContext(member.userId, a.workspaceId, businessProfileId)).rejects.toThrow(
            new BusinessProfileAccessDeniedError(),
          );
        }
      }
      await expect(profileContext(noGrants.userId, a.workspaceId, a1.businessProfileId)).rejects.toBeInstanceOf(
        BusinessProfileAccessDeniedError,
      );
      // The owner of A cannot reach B's profile through A's Workspace either.
      await expect(profileContext(a.ownerUserId, a.workspaceId, b1.businessProfileId)).rejects.toBeInstanceOf(
        BusinessProfileAccessDeniedError,
      );

      expect((await listAuthorizedBusinessProfiles(db(), selectedAdmin.context)).map((profile) => profile.businessProfileId)).toEqual([
        a1.businessProfileId,
      ]);
      expect(await listAuthorizedBusinessProfiles(db(), noGrants.context)).toEqual([]);

      // OWNER/ALL listings contain exactly this Workspace's profiles, never another Workspace's.
      const inA = (await db().businessProfile.findMany({ where: { workspaceId: a.workspaceId }, select: { id: true } })).map((row) => row.id);
      for (const context of [a.context, (await memberInA("AGENT", "ALL")).context]) {
        const listed = (await listAuthorizedBusinessProfiles(db(), context)).map((profile) => profile.businessProfileId);
        expect(new Set(listed)).toEqual(new Set(inA));
        expect(listed).not.toContain(b1.businessProfileId);
      }
    });

    it("extends ALL scope to Business Profiles created later, but never SELECTED scope", async () => {
      const allAgent = await memberInA("AGENT", "ALL");
      const selectedAgent = await memberInA("AGENT", [a1.businessProfileId]);
      const { businessProfileId: later } = await createBusinessProfile(db(), a.context, { name: "Created later" });

      await expect(profileContext(allAgent.userId, a.workspaceId, later)).resolves.toMatchObject({ businessProfileId: later });
      await expect(profileContext(a.ownerUserId, a.workspaceId, later)).resolves.toMatchObject({ businessProfileId: later });
      await expect(profileContext(selectedAgent.userId, a.workspaceId, later)).rejects.toBeInstanceOf(BusinessProfileAccessDeniedError);
      const refreshed = await authorizeWorkspaceAccess(db(), { userId: allAgent.userId, workspaceId: a.workspaceId });
      expect((await listAuthorizedBusinessProfiles(db(), refreshed)).map((profile) => profile.businessProfileId)).toContain(later);
    });

    it("supports one user in several Workspaces with independent roles and scopes", async () => {
      const userId = await createTestUser(db(), nextLabel("multi"));
      await addTestMember(db(), a.workspaceId, userId, "AGENT", [a2.businessProfileId]);
      await addTestMember(db(), b.workspaceId, userId, "ADMIN", "ALL");

      expect(await listWorkspacesForUser(db(), userId)).toEqual([
        { workspaceId: a.workspaceId, name: "Workspace a", role: "AGENT" },
        { workspaceId: b.workspaceId, name: "Workspace b", role: "ADMIN" },
      ]);
      const inA = await profileContext(userId, a.workspaceId, a2.businessProfileId);
      const inB = await profileContext(userId, b.workspaceId, b1.businessProfileId);
      expect((await listInboxConversations(db(), inA)).map((conversation) => conversation.id)).toEqual([a2.conversationId]);
      expect((await listInboxConversations(db(), inB)).map((conversation) => conversation.id)).toEqual([b1.conversationId]);
    });

    it("applies revoked grants, narrowed scope, role downgrades and removed membership on the next request", async () => {
      const grantRevoked = await memberInA("AGENT", [a1.businessProfileId]);
      await db().memberBusinessProfileAccess.deleteMany({ where: { workspaceMemberId: grantRevoked.context.workspaceMemberId } });
      await expect(profileContext(grantRevoked.userId, a.workspaceId, a1.businessProfileId)).rejects.toBeInstanceOf(
        BusinessProfileAccessDeniedError,
      );

      const narrowed = await memberInA("ADMIN", "ALL");
      await db().workspaceMember.update({ where: { id: narrowed.context.workspaceMemberId }, data: { businessProfileScope: "SELECTED" } });
      await expect(profileContext(narrowed.userId, a.workspaceId, a2.businessProfileId)).rejects.toBeInstanceOf(
        BusinessProfileAccessDeniedError,
      );

      const downgraded = await memberInA("ADMIN", [a1.businessProfileId]);
      await db().workspaceMember.update({ where: { id: downgraded.context.workspaceMemberId }, data: { role: "AGENT" } });
      const downgradedContext = await profileContext(downgraded.userId, a.workspaceId, a1.businessProfileId);
      await expect(
        createChannelAccount(db(), downgradedContext, {
          channel: "WHATSAPP",
          externalAccountId: nextLabel("wa-downgraded"),
          capabilities: NO_CAPABILITIES,
        }),
      ).rejects.toBeInstanceOf(WorkspacePermissionError);

      const removed = await memberInA("AGENT", "ALL");
      await db().workspaceMember.delete({ where: { id: removed.context.workspaceMemberId } });
      await expect(profileContext(removed.userId, a.workspaceId, a1.businessProfileId)).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
      await expect(authorizeWorkspaceAccess(db(), { userId: removed.userId, workspaceId: a.workspaceId })).rejects.toBeInstanceOf(
        WorkspaceAccessDeniedError,
      );
    });
  });

  describe("roles and grants", () => {
    it("keeps channel connection, member management and profile creation away from AGENT", async () => {
      const agent = await memberInA("AGENT", "ALL");
      const agentProfile = await profileContext(agent.userId, a.workspaceId, a1.businessProfileId);
      const newcomer = await createTestUser(db(), nextLabel("newcomer"));

      await expect(
        createChannelAccount(db(), agentProfile, { channel: "WHATSAPP", externalAccountId: nextLabel("wa"), capabilities: NO_CAPABILITIES }),
      ).rejects.toBeInstanceOf(WorkspacePermissionError);
      await expect(
        addWorkspaceMember(db(), agent.context, { userId: newcomer, role: "AGENT", businessProfileScope: { selected: [] } }),
      ).rejects.toBeInstanceOf(WorkspacePermissionError);
      await expect(createBusinessProfile(db(), agent.context, { name: "Not allowed" })).rejects.toBeInstanceOf(WorkspacePermissionError);
    });

    it("bounds an ADMIN's grants by the ADMIN's own Business Profile scope", async () => {
      const selectedAdmin = await memberInA("ADMIN", [a1.businessProfileId]);
      const allAdmin = await memberInA("ADMIN", "ALL");
      const grant = (context: WorkspaceContext, role: "OWNER" | "ADMIN" | "AGENT", businessProfileScope: "ALL" | { selected: string[] }) =>
        createTestUser(db(), nextLabel("grantee")).then((userId) =>
          addWorkspaceMember(db(), context, { userId, role, businessProfileScope }).then((result) => ({ userId, ...result })),
        );

      await expect(grant(selectedAdmin.context, "OWNER", "ALL")).rejects.toBeInstanceOf(WorkspacePermissionError);
      await expect(grant(selectedAdmin.context, "AGENT", "ALL")).rejects.toBeInstanceOf(WorkspacePermissionError);
      await expect(grant(selectedAdmin.context, "AGENT", { selected: [a2.businessProfileId] })).rejects.toBeInstanceOf(
        WorkspacePermissionError,
      );
      await expect(createBusinessProfile(db(), selectedAdmin.context, { name: "Not allowed" })).rejects.toBeInstanceOf(
        WorkspacePermissionError,
      );
      const granted = await grant(selectedAdmin.context, "AGENT", { selected: [a1.businessProfileId] });
      await expect(profileContext(granted.userId, a.workspaceId, a1.businessProfileId)).resolves.toBeDefined();
      // A SELECTED grant is stored as SELECTED: it never widens to other or future profiles.
      await expect(profileContext(granted.userId, a.workspaceId, a2.businessProfileId)).rejects.toBeInstanceOf(BusinessProfileAccessDeniedError);
      expect((await authorizeWorkspaceAccess(db(), { userId: granted.userId, workspaceId: a.workspaceId })).businessProfileScope).toEqual({
        kind: "SELECTED",
        businessProfileIds: [a1.businessProfileId],
      });
      const ownerGranted = await grant(a.context, "ADMIN", { selected: [a2.businessProfileId, a2.businessProfileId] });
      expect((await authorizeWorkspaceAccess(db(), { userId: ownerGranted.userId, workspaceId: a.workspaceId })).businessProfileScope).toEqual({
        kind: "SELECTED",
        businessProfileIds: [a2.businessProfileId],
      });
      await expect(profileContext(ownerGranted.userId, a.workspaceId, a1.businessProfileId)).rejects.toBeInstanceOf(
        BusinessProfileAccessDeniedError,
      );

      await expect(grant(allAdmin.context, "OWNER", "ALL")).rejects.toBeInstanceOf(WorkspacePermissionError);
      const allGranted = await grant(allAdmin.context, "AGENT", "ALL");
      await expect(profileContext(allGranted.userId, a.workspaceId, a2.businessProfileId)).resolves.toBeDefined();
      await expect(createBusinessProfile(db(), allAdmin.context, { name: "Allowed" })).resolves.toMatchObject({ status: "SETUP" });

      const owner = await grant(a.context, "OWNER", { selected: [] });
      expect(await authorizeWorkspaceAccess(db(), { userId: owner.userId, workspaceId: a.workspaceId })).toMatchObject({
        role: "OWNER",
        businessProfileScope: { kind: "ALL" },
      });
    });

    it("rejects grants of another Workspace's Business Profile without creating the member", async () => {
      const userId = await createTestUser(db(), nextLabel("foreign-grant"));
      await expect(
        addWorkspaceMember(db(), a.context, { userId, role: "AGENT", businessProfileScope: { selected: [b1.businessProfileId] } }),
      ).rejects.toBeInstanceOf(TenantRecordNotFoundError);
      expect(await db().workspaceMember.count({ where: { userId } })).toBe(0);
    });
  });

  describe("reads across Business Profiles and Workspaces", () => {
    it("never return another profile's records, and look exactly like missing records", async () => {
      const agent = await memberInA("AGENT", [a1.businessProfileId]);
      const context = await profileContext(agent.userId, a.workspaceId, a1.businessProfileId);

      for (const foreign of [a2, b1]) {
        expect(await getConversation(db(), context, foreign.conversationId)).toBeNull();
        expect(await getChannelAccount(db(), context, foreign.channelAccount.id)).toBeNull();
        expect(await listInboxConversations(db(), context, { channelAccountId: foreign.channelAccount.id })).toEqual([]);
        // Through `readConversation`, which is the reader the Inbox actually uses. This used to assert
        // against `listConversationMessages`, a repository function with no caller anywhere — so the
        // tenancy property it proved was a property of dead code. The production reader refuses by
        // answering `undefined`, deliberately: "a URL someone typed should produce not-found, and a
        // thrown tenancy error rendered as a stack trace tells an attacker the row exists".
        expect(await readConversation(db(), context, foreign.conversationId)).toBeUndefined();
      }
      expect(await getConversation(db(), context, MISSING_ID)).toBeNull();
      expect(await readConversation(db(), context, MISSING_ID)).toBeUndefined();

      expect((await listInboxConversations(db(), context)).map((conversation) => conversation.id)).toEqual([a1.conversationId]);
      expect((await listChannelAccounts(db(), context)).map((account) => account.id)).toEqual([a1.channelAccount.id]);
      // Channel account records never expose the credential reference.
      for (const account of [...(await listChannelAccounts(db(), context)), await getChannelAccount(db(), context, a1.channelAccount.id)]) {
        expect(account).not.toHaveProperty("credentialId");
        expect(account).not.toHaveProperty("credential");
      }
      // The positive control: the profile's own conversation reads, with its message.
      expect((await readConversation(db(), context, a1.conversationId))?.messages).toHaveLength(1);
    });

    it("keeps the same provider user as separate contacts and identities per Business Profile", async () => {
      const identities = await db().channelIdentity.findMany({
        where: { workspaceId: a.workspaceId, externalUserId: "ig-user-a" },
        orderBy: { businessProfileId: "asc" },
      });
      expect(identities).toHaveLength(2);
      expect(new Set(identities.map((identity) => identity.businessProfileId))).toEqual(new Set([a1.businessProfileId, a2.businessProfileId]));
      expect(new Set(identities.map((identity) => identity.contactId)).size).toBe(2);

      await expect(
        createContactWithChannelIdentity(db(), a1.context, { channelAccountId: a1.channelAccount.id, externalUserId: "ig-user-a" }),
      ).rejects.toMatchObject({ code: "P2002" });
    });
  });

  describe("writes across Business Profiles and Workspaces", () => {
    it("cannot update or append to another profile's conversation", async () => {
      for (const foreign of [a2, b1]) {
        const before = await db().conversation.findUniqueOrThrow({ where: { id: foreign.conversationId } });
        await expect(setConversationLeadStage(db(), a1.context, foreign.conversationId, "LOST")).rejects.toBeInstanceOf(
          TenantRecordNotFoundError,
        );
        await expect(
          appendInboundMessage(db(), a1.context, { conversationId: foreign.conversationId, kind: "TEXT", text: "intrusion", occurredAt: new Date() }),
        ).rejects.toBeInstanceOf(TenantRecordNotFoundError);
        const after = await db().conversation.findUniqueOrThrow({ where: { id: foreign.conversationId } });
        expect(after).toMatchObject({ leadStage: before.leadStage, stateVersion: before.stateVersion });
        expect(await db().message.count({ where: { conversationId: foreign.conversationId } })).toBe(1);
      }
    });

    it("cannot attach contacts, identities or conversations to another profile's records", async () => {
      const counts = async () => ({ contacts: await db().contact.count(), conversations: await db().conversation.count() });
      const before = await counts();

      for (const foreign of [a2, b1]) {
        await expect(
          createContactWithChannelIdentity(db(), a1.context, { channelAccountId: foreign.channelAccount.id, externalUserId: "intruder" }),
        ).rejects.toBeInstanceOf(TenantRecordNotFoundError);
        await expect(
          createConversation(db(), a1.context, { channelAccountId: foreign.channelAccount.id, channelIdentityId: foreign.channelIdentityId }),
        ).rejects.toBeInstanceOf(TenantRecordNotFoundError);
        await expect(
          createConversation(db(), a1.context, { channelAccountId: a1.channelAccount.id, channelIdentityId: foreign.channelIdentityId }),
        ).rejects.toBeInstanceOf(TenantRecordNotFoundError);
      }
      expect(await counts()).toEqual(before);
    });

    it("advances the state version exactly once per stored inbound message and not on lead-stage changes", async () => {
      const before = (await db().conversation.findUniqueOrThrow({ where: { id: a1.conversationId } })).stateVersion;
      await appendInboundMessage(db(), a1.context, { conversationId: a1.conversationId, kind: "TEXT", text: "again", occurredAt: new Date() });
      expect((await db().conversation.findUniqueOrThrow({ where: { id: a1.conversationId } })).stateVersion).toBe(before + 1);
      await setConversationLeadStage(db(), a1.context, a1.conversationId, "ENGAGED");
      expect((await db().conversation.findUniqueOrThrow({ where: { id: a1.conversationId } })).stateVersion).toBe(before + 1);
    });

    it("rejects forged contexts at every repository entry point without writing", async () => {
      const forgedProfiles = [{ ...a1.context }, { ...a.context, businessProfileId: a2.businessProfileId }] as unknown as BusinessProfileContext[];
      for (const forged of forgedProfiles) {
        const attempts: Promise<unknown>[] = [
          getConversation(db(), forged, a2.conversationId),
          listInboxConversations(db(), forged),
          setConversationLeadStage(db(), forged, a2.conversationId, "LOST"),
          appendInboundMessage(db(), forged, { conversationId: a2.conversationId, kind: "TEXT", occurredAt: new Date() }),
          readConversation(db(), forged, a2.conversationId),
          getChannelAccount(db(), forged, a2.channelAccount.id),
          listChannelAccounts(db(), forged),
          createChannelAccount(db(), forged, { channel: "WHATSAPP", externalAccountId: "forged", capabilities: NO_CAPABILITIES }),
          createContactWithChannelIdentity(db(), forged, { channelAccountId: a2.channelAccount.id, externalUserId: "forged" }),
          createConversation(db(), forged, { channelAccountId: a2.channelAccount.id, channelIdentityId: a2.channelIdentityId }),
        ];
        for (const attempt of attempts) {
          await expect(attempt).rejects.toThrow(/access denied/);
        }
      }
      const forgedWorkspace = { ...a.context } as WorkspaceContext;
      await expect(listAuthorizedBusinessProfiles(db(), forgedWorkspace)).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
      await expect(createBusinessProfile(db(), forgedWorkspace, { name: "forged" })).rejects.toBeInstanceOf(WorkspaceAccessDeniedError);
      expect((await db().conversation.findUniqueOrThrow({ where: { id: a2.conversationId } })).leadStage).toBe("NEW");
    });
  });
});
