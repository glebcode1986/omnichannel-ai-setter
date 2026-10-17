/**
 * Test/seed helpers. All values are fake; nothing here resembles a real account or credential.
 */
import { NO_CAPABILITIES, type WorkspaceRole } from "@omnichannel/domain";

import type { DbClient } from "../client";
import type { Prisma } from "../generated/prisma/client";
import { createChannelAccount, type ChannelAccountRecord } from "../repositories/channel-accounts";
import { createContactWithChannelIdentity } from "../repositories/contacts";
import { createConversation } from "../repositories/conversations";
import { appendInboundMessage } from "../repositories/messages";
import { createBusinessProfile, createWorkspaceWithOwner } from "../repositories/workspaces";
import {
  authorizeBusinessProfileAccess,
  authorizeWorkspaceAccess,
  type BusinessProfileContext,
  type WorkspaceContext,
} from "../tenancy";

export async function createTestUser(db: DbClient, label: string): Promise<string> {
  const user = await db.user.create({ data: { name: `Test ${label}`, email: `${label}@example.test` } });
  return user.id;
}

export interface SeededProfile {
  readonly businessProfileId: string;
  /** Owner's context for this profile. */
  readonly context: BusinessProfileContext;
  readonly channelAccount: ChannelAccountRecord;
  readonly contactId: string;
  readonly channelIdentityId: string;
  readonly conversationId: string;
  readonly messageId: string;
}

export interface SeededWorkspace {
  readonly ownerUserId: string;
  readonly workspaceId: string;
  /** Owner's Workspace context. */
  readonly context: WorkspaceContext;
  readonly profiles: readonly SeededProfile[];
}

/**
 * A Workspace with an OWNER and one Business Profile per label. Each profile gets an Instagram account, a
 * contact + channel identity, a conversation and one inbound message. All profiles of one Workspace receive
 * the same provider user ID (`ig-user-<label>`), so cross-profile isolation is exercised by default.
 */
export async function seedWorkspace(
  db: DbClient,
  label: string,
  profileLabels: readonly string[] = ["main"],
): Promise<SeededWorkspace> {
  const ownerUserId = await createTestUser(db, `${label}-owner`);
  const { workspaceId } = await createWorkspaceWithOwner(db, { name: `Workspace ${label}`, ownerUserId });
  const context = await authorizeWorkspaceAccess(db, { userId: ownerUserId, workspaceId });

  const profiles: SeededProfile[] = [];
  for (const profileLabel of profileLabels) {
    const { businessProfileId } = await createBusinessProfile(db, context, { name: `Profile ${label}-${profileLabel}` });
    const profileContext = await authorizeBusinessProfileAccess(db, { userId: ownerUserId, workspaceId, businessProfileId });
    const channelAccount = await createChannelAccount(db, profileContext, {
      channel: "INSTAGRAM",
      externalAccountId: `ig-account-${label}-${profileLabel}`,
      displayName: `Account ${label}-${profileLabel}`,
      capabilities: { ...NO_CAPABILITIES, text: true },
    });
    const { contactId, channelIdentityId } = await createContactWithChannelIdentity(db, profileContext, {
      channelAccountId: channelAccount.id,
      externalUserId: `ig-user-${label}`,
      displayName: `Customer ${label}`,
    });
    const conversation = await createConversation(db, profileContext, { channelAccountId: channelAccount.id, channelIdentityId });
    const message = await appendInboundMessage(db, profileContext, {
      conversationId: conversation.id,
      channelMessageId: `mid-${label}-${profileLabel}-1`,
      kind: "TEXT",
      text: `hello from ${label}-${profileLabel}`,
      occurredAt: new Date("2026-09-17T10:00:00.000Z"),
    });
    profiles.push({
      businessProfileId,
      context: profileContext,
      channelAccount,
      contactId,
      channelIdentityId,
      conversationId: conversation.id,
      messageId: message.id,
    });
  }

  return { ownerUserId, workspaceId, context, profiles };
}

/**
 * Changes the Business Profile's automation default to what a case needs.
 *
 * It already exists: `createBusinessProfile` writes the conservative default in the same statement as the
 * profile, because a profile that cannot be configured is not a usable profile. So a case that wants
 * AUTOPILOT, or an empty mandatory-review floor, is *editing* settings rather than inventing them — which
 * is also what the product does, and a fixture that still created one would be writing a second profile
 * default past a partial unique index.
 *
 * It insists on having changed exactly one row. A fixture that silently matched none is how a suite ends
 * up asserting against the default it meant to replace.
 */
export async function setProfileDefaultPolicy(
  db: DbClient,
  scope: { readonly workspaceId: string; readonly businessProfileId: string },
  data: Prisma.AutomationPolicyUpdateManyMutationInput,
): Promise<void> {
  const { count } = await db.automationPolicy.updateMany({
    where: { workspaceId: scope.workspaceId, businessProfileId: scope.businessProfileId, channelAccountId: null },
    data,
  });
  if (count !== 1) {
    throw new Error(`expected one Business Profile default policy to update, matched ${count}`);
  }
}

/** Adds an existing user directly (test setup only; production uses addWorkspaceMember). */
export async function addTestMember(
  db: DbClient,
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
  scope: "ALL" | readonly string[],
): Promise<WorkspaceContext> {
  const member = await db.workspaceMember.create({
    data: { workspaceId, userId, role, businessProfileScope: scope === "ALL" ? "ALL" : "SELECTED" },
  });
  if (scope !== "ALL" && scope.length > 0) {
    await db.memberBusinessProfileAccess.createMany({
      data: scope.map((businessProfileId) => ({ workspaceId, workspaceMemberId: member.id, businessProfileId })),
    });
  }
  return authorizeWorkspaceAccess(db, { userId, workspaceId });
}
