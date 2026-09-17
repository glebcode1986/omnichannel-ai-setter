import { isValidIdentifier, type ConversationStatus, type LeadStage } from "@omnichannel/domain";

import type { DbExecutor } from "../client";
import { rethrowAsTenantNotFound, TenantRecordNotFoundError } from "../errors";
import type { Conversation } from "../generated/prisma/client";
import { scopeOf, type WorkspaceContext } from "../tenancy";

const DEFAULT_INBOX_LIMIT = 50;
const MAX_INBOX_LIMIT = 100;

/**
 * Opens the conversation thread for a contact identity. The identity must belong to the given channel
 * account inside the caller's workspace (enforced by a composite foreign key).
 */
export async function createConversation(
  db: DbExecutor,
  context: WorkspaceContext,
  input: { readonly channelAccountId: string; readonly contactIdentityId: string },
): Promise<Conversation> {
  const workspaceId = scopeOf(context);
  if (!isValidIdentifier(input.channelAccountId) || !isValidIdentifier(input.contactIdentityId)) {
    throw new TenantRecordNotFoundError("ContactIdentity");
  }
  // Explicit scoped lookup first; the composite foreign key is defense in depth, not the primary check.
  const identity = await db.contactIdentity.findUnique({
    where: {
      workspaceId_channelAccountId_id: {
        workspaceId,
        channelAccountId: input.channelAccountId,
        id: input.contactIdentityId,
      },
    },
    select: { id: true },
  });
  if (identity === null) {
    throw new TenantRecordNotFoundError("ContactIdentity");
  }
  try {
    return await db.conversation.create({
      data: { workspaceId, channelAccountId: input.channelAccountId, contactIdentityId: input.contactIdentityId },
    });
  } catch (error) {
    return rethrowAsTenantNotFound(error, "ContactIdentity");
  }
}

export async function getConversation(
  db: DbExecutor,
  context: WorkspaceContext,
  conversationId: string,
): Promise<Conversation | null> {
  const workspaceId = scopeOf(context);
  if (!isValidIdentifier(conversationId)) {
    return null;
  }
  return db.conversation.findUnique({ where: { workspaceId_id: { workspaceId, id: conversationId } } });
}

export interface InboxQuery {
  readonly status?: ConversationStatus;
  readonly channelAccountId?: string;
  readonly limit?: number;
}

/** Workspace inbox ordered by latest activity (served by the workspace/status/last_message_at index). */
export async function listInboxConversations(
  db: DbExecutor,
  context: WorkspaceContext,
  query: InboxQuery = {},
): Promise<Conversation[]> {
  const workspaceId = scopeOf(context);
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? DEFAULT_INBOX_LIMIT), 1), MAX_INBOX_LIMIT);
  return db.conversation.findMany({
    where: {
      workspaceId,
      status: query.status ?? "OPEN",
      ...(query.channelAccountId === undefined ? {} : { channelAccountId: query.channelAccountId }),
    },
    orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
    take: limit,
  });
}

export async function setConversationLeadStage(
  db: DbExecutor,
  context: WorkspaceContext,
  conversationId: string,
  leadStage: LeadStage,
): Promise<Conversation> {
  const workspaceId = scopeOf(context);
  if (!isValidIdentifier(conversationId)) {
    throw new TenantRecordNotFoundError("Conversation");
  }
  try {
    return await db.conversation.update({
      where: { workspaceId_id: { workspaceId, id: conversationId } },
      data: { leadStage },
    });
  } catch (error) {
    return rethrowAsTenantNotFound(error, "Conversation");
  }
}
