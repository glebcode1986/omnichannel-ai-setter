import { isValidIdentifier, type MediaReference, type MessageKind } from "@omnichannel/domain";

import type { DbClient } from "../client";
import { TenantRecordNotFoundError } from "../errors";
import type { Message } from "../generated/prisma/client";
import { cancelPendingFollowUps } from "../followup-store";
import { profileScopeOf, type BusinessProfileContext } from "../tenancy";

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

/**
 * Stores a participant message and, in the same transaction, advances the conversation's inbound/inbox
 * timestamps and its state version (a new customer message makes anchored drafts and reviews stale).
 *
 * The conversation row is locked before it is read, and the lock is held until commit. Without it, two
 * messages arriving at once both read the same timestamps, each computes a maximum from that stale
 * snapshot, and whichever commits last wins — so a 01:00 message delivered late can push `lastInboundAt`
 * *backwards* from 02:00. The row would then claim the conversation's newest activity is older than a
 * message it already contains, and every recency and messaging-window calculation downstream inherits the
 * error. Incrementing `stateVersion` does not help: the timestamps are separate columns, assigned absolute
 * values rather than derived in the database.
 */
export async function appendInboundMessage(
  db: DbClient,
  context: BusinessProfileContext,
  input: NewInboundMessage,
): Promise<Message> {
  const scope = profileScopeOf(context);
  if (!isValidIdentifier(input.conversationId)) {
    throw new TenantRecordNotFoundError("Conversation");
  }

  return db.$transaction(async (tx) => {
    const key = { workspaceId_businessProfileId_id: { ...scope, id: input.conversationId } };
    // Locked first, and held through commit, so the read below and the write at the end cannot be
    // interleaved with another append to the same conversation. The predicate carries the full tenant
    // scope, so this can never lock another Workspace's or Business Profile's row.
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "conversations"
      WHERE "workspace_id" = ${scope.workspaceId}
        AND "business_profile_id" = ${scope.businessProfileId}
        AND "id" = ${input.conversationId}
      FOR UPDATE`;
    if (locked.length === 0) {
      throw new TenantRecordNotFoundError("Conversation");
    }
    const conversation = await tx.conversation.findUnique({
      where: key,
      select: { channelAccountId: true, lastInboundAt: true, lastMessageAt: true },
    });
    if (conversation === null) {
      throw new TenantRecordNotFoundError("Conversation");
    }

    const message = await tx.message.create({
      data: {
        ...scope,
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
      where: key,
      data: {
        lastInboundAt: latest(conversation.lastInboundAt, input.occurredAt),
        lastMessageAt: latest(conversation.lastMessageAt, input.occurredAt),
        stateVersion: { increment: 1 },
      },
    });
    // The customer wrote back, so any follow-up waiting to chase their silence is about a question that
    // has moved on (#55). Cancelled in *this* transaction, under the lock this append already holds, so
    // "they replied" and "the chase is off" are one fact rather than two that a crash could separate.
    // `claimFollowUp` re-asks the same question at execution anyway; this is the prompt path, and a
    // follow-up that is already superseded in the table is one no worker has to reason about.
    await cancelPendingFollowUps(tx, scope, input.conversationId, "NEW_INBOUND", input.occurredAt);
    return message;
  });
}

function latest(current: Date | null, candidate: Date): Date {
  return current !== null && current.getTime() > candidate.getTime() ? current : candidate;
}
