import { isValidIdentifier, type MediaReference, type MessageKind } from "@omnichannel/domain";

import type { DbClient, DbExecutor } from "../client";
import { TenantRecordNotFoundError } from "../errors";
import type { Message } from "../generated/prisma/client";
import { scopeOf, type WorkspaceContext } from "../tenancy";

const DEFAULT_MESSAGE_LIMIT = 200;
const MAX_MESSAGE_LIMIT = 500;

export interface NewInboundMessage {
  readonly conversationId: string;
  readonly channelMessageId?: string;
  readonly kind: MessageKind;
  readonly text?: string;
  readonly media?: readonly MediaReference[];
  readonly replyToChannelMessageId?: string;
  /** Platform timestamp of the message. */
  readonly occurredAt: Date;
}

/** Stores a participant message and advances the conversation's inbound/inbox timestamps atomically. */
export async function appendInboundMessage(
  db: DbClient,
  context: WorkspaceContext,
  input: NewInboundMessage,
): Promise<Message> {
  const workspaceId = scopeOf(context);
  if (!isValidIdentifier(input.conversationId)) {
    throw new TenantRecordNotFoundError("Conversation");
  }

  return db.$transaction(async (tx) => {
    const conversation = await tx.conversation.findUnique({
      where: { workspaceId_id: { workspaceId, id: input.conversationId } },
      select: { channelAccountId: true, lastInboundAt: true, lastMessageAt: true },
    });
    if (conversation === null) {
      throw new TenantRecordNotFoundError("Conversation");
    }

    const message = await tx.message.create({
      data: {
        workspaceId,
        channelAccountId: conversation.channelAccountId,
        conversationId: input.conversationId,
        channelMessageId: input.channelMessageId,
        direction: "IN",
        source: "PARTICIPANT",
        kind: input.kind,
        text: input.text,
        media: (input.media ?? []).map((media) => ({ ...media })),
        replyToChannelMessageId: input.replyToChannelMessageId,
        occurredAt: input.occurredAt,
      },
    });
    await tx.conversation.update({
      where: { workspaceId_id: { workspaceId, id: input.conversationId } },
      data: {
        lastInboundAt: latest(conversation.lastInboundAt, input.occurredAt),
        lastMessageAt: latest(conversation.lastMessageAt, input.occurredAt),
      },
    });
    return message;
  });
}

export async function listConversationMessages(
  db: DbExecutor,
  context: WorkspaceContext,
  conversationId: string,
  options: { readonly limit?: number } = {},
): Promise<Message[]> {
  const workspaceId = scopeOf(context);
  const conversation = isValidIdentifier(conversationId)
    ? await db.conversation.findUnique({
        where: { workspaceId_id: { workspaceId, id: conversationId } },
        select: { id: true },
      })
    : null;
  if (conversation === null) {
    throw new TenantRecordNotFoundError("Conversation");
  }
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_MESSAGE_LIMIT), 1), MAX_MESSAGE_LIMIT);
  return db.message.findMany({
    where: { workspaceId, conversationId },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    take: limit,
  });
}

function latest(current: Date | null, candidate: Date): Date {
  return current !== null && current.getTime() > candidate.getTime() ? current : candidate;
}
