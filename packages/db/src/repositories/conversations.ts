import { isValidIdentifier, type ConversationStatus, type LeadStage } from "@omnichannel/domain";

import type { DbExecutor } from "../client";
import { rethrowAsTenantNotFound, TenantRecordNotFoundError } from "../errors";
import type { Conversation } from "../generated/prisma/client";
import { profileScopeOf, type BusinessProfileContext } from "../tenancy";

const DEFAULT_INBOX_LIMIT = 50;
const MAX_INBOX_LIMIT = 100;

/**
 * Opens the conversation thread for a channel identity. The identity must belong to the given channel
 * account inside the context's Business Profile; the conversation's contact is the identity's contact.
 */
export async function createConversation(
  db: DbExecutor,
  context: BusinessProfileContext,
  input: { readonly channelAccountId: string; readonly channelIdentityId: string },
): Promise<Conversation> {
  const scope = profileScopeOf(context);
  if (!isValidIdentifier(input.channelAccountId) || !isValidIdentifier(input.channelIdentityId)) {
    throw new TenantRecordNotFoundError("ChannelIdentity");
  }
  // Explicit scoped lookup first; the composite foreign keys are defense in depth, not the primary check.
  const identity = await db.channelIdentity.findUnique({
    where: {
      workspaceId_businessProfileId_channelAccountId_id: {
        ...scope,
        channelAccountId: input.channelAccountId,
        id: input.channelIdentityId,
      },
    },
    select: { id: true, contactId: true },
  });
  if (identity === null) {
    throw new TenantRecordNotFoundError("ChannelIdentity");
  }
  try {
    return await db.conversation.create({
      data: {
        ...scope,
        channelAccountId: input.channelAccountId,
        channelIdentityId: identity.id,
        contactId: identity.contactId,
      },
    });
  } catch (error) {
    return rethrowAsTenantNotFound(error, "ChannelIdentity");
  }
}

export async function getConversation(
  db: DbExecutor,
  context: BusinessProfileContext,
  conversationId: string,
): Promise<Conversation | null> {
  const scope = profileScopeOf(context);
  if (!isValidIdentifier(conversationId)) {
    return null;
  }
  return db.conversation.findUnique({ where: { workspaceId_businessProfileId_id: { ...scope, id: conversationId } } });
}

export interface InboxQuery {
  readonly status?: ConversationStatus;
  readonly channelAccountId?: string;
  readonly limit?: number;
}

/** Business Profile inbox ordered by latest activity (served by the profile inbox index). */
export async function listInboxConversations(
  db: DbExecutor,
  context: BusinessProfileContext,
  query: InboxQuery = {},
): Promise<Conversation[]> {
  const scope = profileScopeOf(context);
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? DEFAULT_INBOX_LIMIT), 1), MAX_INBOX_LIMIT);
  return db.conversation.findMany({
    where: {
      ...scope,
      status: query.status ?? "OPEN",
      ...(query.channelAccountId === undefined ? {} : { channelAccountId: query.channelAccountId }),
    },
    orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
    take: limit,
  });
}

/** Lead-stage changes do not advance the conversation state version. */
export async function setConversationLeadStage(
  db: DbExecutor,
  context: BusinessProfileContext,
  conversationId: string,
  leadStage: LeadStage,
): Promise<Conversation> {
  const scope = profileScopeOf(context);
  if (!isValidIdentifier(conversationId)) {
    throw new TenantRecordNotFoundError("Conversation");
  }
  try {
    return await db.conversation.update({
      where: { workspaceId_businessProfileId_id: { ...scope, id: conversationId } },
      data: { leadStage },
    });
  } catch (error) {
    return rethrowAsTenantNotFound(error, "Conversation");
  }
}
