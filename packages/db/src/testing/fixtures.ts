/**
 * Test/seed helpers. All values are fake; nothing here resembles a real account or credential.
 */
import { NO_CAPABILITIES, type WorkspaceRole } from "@omnichannel/domain";

import type { DbClient } from "../client";
import type { ChannelAccountRecord } from "../repositories/channel-accounts";
import { createChannelAccount } from "../repositories/channel-accounts";
import { createContactWithIdentity } from "../repositories/contacts";
import { createConversation } from "../repositories/conversations";
import { appendInboundMessage } from "../repositories/messages";
import { createWorkspaceWithOwner } from "../repositories/workspaces";
import { authorizeWorkspaceAccess, type WorkspaceContext } from "../tenancy";

export async function createTestUser(db: DbClient, label: string): Promise<string> {
  const user = await db.user.create({ data: { name: `Test ${label}`, email: `${label}@example.test` } });
  return user.id;
}

export interface SeededWorkspace {
  readonly ownerUserId: string;
  readonly context: WorkspaceContext;
  readonly channelAccount: ChannelAccountRecord;
  readonly contactId: string;
  readonly contactIdentityId: string;
  readonly conversationId: string;
  readonly messageId: string;
}

/** A workspace with an owner, one Instagram account, one contact identity, one conversation and one message. */
export async function seedWorkspace(db: DbClient, label: string): Promise<SeededWorkspace> {
  const ownerUserId = await createTestUser(db, `${label}-owner`);
  const { workspaceId } = await createWorkspaceWithOwner(db, { name: `Workspace ${label}`, ownerUserId });
  const context = await authorizeWorkspaceAccess(db, { userId: ownerUserId, workspaceId });

  const channelAccount = await createChannelAccount(db, context, {
    channel: "INSTAGRAM",
    externalAccountId: `ig-account-${label}`,
    displayName: `Account ${label}`,
    capabilities: { ...NO_CAPABILITIES, text: true },
  });
  const { contactId, contactIdentityId } = await createContactWithIdentity(db, context, {
    channelAccountId: channelAccount.id,
    externalUserId: `ig-user-${label}`,
    displayName: `Customer ${label}`,
  });
  const conversation = await createConversation(db, context, { channelAccountId: channelAccount.id, contactIdentityId });
  const message = await appendInboundMessage(db, context, {
    conversationId: conversation.id,
    channelMessageId: `mid-${label}-1`,
    kind: "TEXT",
    text: `hello from ${label}`,
    occurredAt: new Date("2026-09-17T10:00:00.000Z"),
  });

  return {
    ownerUserId,
    context,
    channelAccount,
    contactId,
    contactIdentityId,
    conversationId: conversation.id,
    messageId: message.id,
  };
}

/** Adds an existing user to a workspace directly (test setup only; production uses addWorkspaceMember). */
export async function addTestMember(
  db: DbClient,
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
): Promise<WorkspaceContext> {
  await db.workspaceMember.create({ data: { workspaceId, userId, role } });
  return authorizeWorkspaceAccess(db, { userId, workspaceId });
}
