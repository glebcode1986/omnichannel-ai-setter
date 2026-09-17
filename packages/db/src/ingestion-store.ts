/**
 * PostgreSQL implementation of the application's ingestion ports. Webhook ingestion is a system flow: the
 * workspace comes from the resolved channel account, and every query stays scoped to that workspace and
 * account. Idempotency relies on unique constraints with ON CONFLICT DO NOTHING (`skipDuplicates`), so
 * concurrent deliveries of the same event never abort a transaction.
 */
import type {
  InboundDebouncePayload,
  IngestionStore,
  IngestionTransaction,
  OutboxEntry,
  WebhookAccount,
} from "@omnichannel/application";

import type { DbClient } from "./client";
import type { Prisma } from "./generated/prisma/client";

type TransactionClient = Prisma.TransactionClient;

const TRANSACTION_TIMEOUT_MS = 10_000;

export function createIngestionStore(db: DbClient): IngestionStore {
  return {
    async findWebhookAccount(channel, channelAccountId): Promise<WebhookAccount | undefined> {
      const account = await db.channelAccount.findFirst({
        where: { id: channelAccountId, channel },
        select: { id: true, workspaceId: true, channel: true, status: true },
      });
      return account === null
        ? undefined
        : { workspaceId: account.workspaceId, channelAccountId: account.id, channel: account.channel, status: account.status };
    },

    transaction(work) {
      return db.$transaction((tx) => work(createTransaction(tx)), { timeout: TRANSACTION_TIMEOUT_MS });
    },

    async claimOutboxEntries({ now, limit, leaseMs, ids }): Promise<OutboxEntry[]> {
      const claimable = {
        dispatchedAt: null,
        availableAt: { lte: now },
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
      } satisfies Prisma.QueueOutboxWhereInput;
      const candidates = await db.queueOutbox.findMany({
        where: { ...claimable, ...(ids === undefined ? {} : { id: { in: [...ids] } }) },
        orderBy: { createdAt: "asc" },
        take: limit,
        select: { id: true },
      });

      const claimed: OutboxEntry[] = [];
      for (const { id } of candidates) {
        // Conditional update = lease: only one dispatcher wins each entry.
        const { count } = await db.queueOutbox.updateMany({
          where: { id, ...claimable },
          data: { lockedUntil: new Date(now.getTime() + leaseMs), attempts: { increment: 1 } },
        });
        if (count === 1) {
          const entry = await db.queueOutbox.findUniqueOrThrow({ where: { id } });
          claimed.push({
            id: entry.id,
            kind: entry.kind,
            workspaceId: entry.workspaceId,
            correlationId: entry.correlationId,
            payload: entry.payload as unknown as InboundDebouncePayload,
            delayMs: entry.delayMs,
            createdAt: entry.createdAt,
            attempts: entry.attempts,
          });
        }
      }
      return claimed;
    },

    async markOutboxDispatched({ id, now }) {
      await db.queueOutbox.update({ where: { id }, data: { dispatchedAt: now, lockedUntil: null } });
    },

    async markOutboxFailed({ id, errorName, retryAt }) {
      await db.queueOutbox.update({
        where: { id },
        data: { lockedUntil: null, availableAt: retryAt, lastErrorName: errorName.slice(0, 255) },
      });
    },
  };
}

function createTransaction(tx: TransactionClient): IngestionTransaction {
  return {
    async claimSourceEvent(event) {
      const { count } = await tx.inboundEvent.createMany({
        data: [
          {
            workspaceId: event.workspaceId,
            channelAccountId: event.channelAccountId,
            sourceEventId: event.sourceEventId,
            eventType: event.eventType,
            occurredAt: event.occurredAt,
            correlationId: event.correlationId,
          },
        ],
        skipDuplicates: true,
      });
      return count === 1 ? "NEW" : "DUPLICATE";
    },

    async completeSourceEvent(event) {
      await tx.inboundEvent.update({
        where: {
          workspaceId_channelAccountId_sourceEventId: {
            workspaceId: event.workspaceId,
            channelAccountId: event.channelAccountId,
            sourceEventId: event.sourceEventId,
          },
        },
        data: { outcome: event.outcome, processedAt: new Date() },
      });
    },

    async ensureContactIdentity(input) {
      const key = {
        workspaceId_channelAccountId_externalUserId: {
          workspaceId: input.workspaceId,
          channelAccountId: input.channelAccountId,
          externalUserId: input.externalUserId,
        },
      };
      const existing = await tx.contactIdentity.findUnique({ where: key, select: { id: true, displayName: true, username: true } });
      if (existing !== null) {
        const displayName = input.displayName ?? existing.displayName;
        const username = input.username ?? existing.username;
        if (displayName !== existing.displayName || username !== existing.username) {
          await tx.contactIdentity.update({ where: { id: existing.id }, data: { displayName, username } });
        }
        return { contactIdentityId: existing.id };
      }

      const contact = await tx.contact.create({
        data: { workspaceId: input.workspaceId, displayName: input.displayName },
        select: { id: true },
      });
      const created = await tx.contactIdentity.createManyAndReturn({
        data: [
          {
            workspaceId: input.workspaceId,
            contactId: contact.id,
            channelAccountId: input.channelAccountId,
            externalUserId: input.externalUserId,
            displayName: input.displayName,
            username: input.username,
          },
        ],
        skipDuplicates: true,
        select: { id: true },
      });
      if (created[0] !== undefined) {
        return { contactIdentityId: created[0].id };
      }
      // A concurrent ingestion created the identity first: drop our unused contact and use theirs.
      await tx.contact.delete({ where: { id: contact.id } });
      const winner = await tx.contactIdentity.findUniqueOrThrow({ where: key, select: { id: true } });
      return { contactIdentityId: winner.id };
    },

    async ensureConversation(input) {
      const key = {
        workspaceId_channelAccountId_contactIdentityId: {
          workspaceId: input.workspaceId,
          channelAccountId: input.channelAccountId,
          contactIdentityId: input.contactIdentityId,
        },
      };
      const select = { id: true, status: true, aiEnabled: true, takeoverState: true } as const;
      await tx.conversation.createMany({
        data: [{ workspaceId: input.workspaceId, channelAccountId: input.channelAccountId, contactIdentityId: input.contactIdentityId }],
        skipDuplicates: true,
      });
      const conversation = await tx.conversation.findUniqueOrThrow({ where: key, select });
      return {
        conversationId: conversation.id,
        status: conversation.status,
        aiEnabled: conversation.aiEnabled,
        takeoverState: conversation.takeoverState,
      };
    },

    async insertMessage(input) {
      const created = await tx.message.createManyAndReturn({
        data: [
          {
            workspaceId: input.workspaceId,
            channelAccountId: input.channelAccountId,
            conversationId: input.conversationId,
            channelMessageId: input.channelMessageId,
            direction: input.direction,
            source: input.source,
            kind: input.kind,
            text: input.text,
            media: input.media.map((media) => ({ ...media })),
            replyToChannelMessageId: input.replyToChannelMessageId,
            deliveryStatus: input.deliveryStatus,
            occurredAt: input.occurredAt,
          },
        ],
        skipDuplicates: true,
        select: { id: true },
      });
      return created[0] === undefined ? undefined : { messageId: created[0].id };
    },

    async recordActivity({ workspaceId, conversationId, direction, occurredAt }) {
      if (direction === "IN") {
        await tx.$executeRaw`
          UPDATE "conversations"
          SET "last_inbound_at" = GREATEST(COALESCE("last_inbound_at", ${occurredAt}), ${occurredAt}),
              "last_message_at" = GREATEST("last_message_at", ${occurredAt}),
              "updated_at" = now()
          WHERE "workspace_id" = ${workspaceId} AND "id" = ${conversationId}`;
      } else {
        await tx.$executeRaw`
          UPDATE "conversations"
          SET "last_outbound_at" = GREATEST(COALESCE("last_outbound_at", ${occurredAt}), ${occurredAt}),
              "last_message_at" = GREATEST("last_message_at", ${occurredAt}),
              "updated_at" = now()
          WHERE "workspace_id" = ${workspaceId} AND "id" = ${conversationId}`;
      }
    },

    async isAppOriginatedMessage({ workspaceId, channelAccountId, platformMessageId }) {
      const message = await tx.message.findFirst({
        where: { workspaceId, channelAccountId, channelMessageId: platformMessageId, direction: "OUT", operationId: { not: null } },
        select: { id: true },
      });
      if (message !== null) {
        return true;
      }
      // The send result may be recorded on the delivery job before the outbound message row exists.
      const job = await tx.deliveryJobRecord.findFirst({
        where: { workspaceId, platformMessageId, draft: { conversation: { channelAccountId } } },
        select: { id: true },
      });
      return job !== null;
    },

    async startHumanTakeover({ workspaceId, conversationId, since, pausedUntil }) {
      // A new manual outbound extends an existing human takeover; otherwise it starts one (HUMAN_HANDOFF.md).
      await tx.$executeRaw`
        UPDATE "conversations"
        SET "takeover_reason" = CASE WHEN "takeover_state" = 'HUMAN_ACTIVE' THEN "takeover_reason" ELSE 'UNMATCHED_OUTBOUND_ECHO'::"TakeoverReason" END,
            "human_takeover_at" = CASE WHEN "takeover_state" = 'HUMAN_ACTIVE' THEN "human_takeover_at" ELSE ${since} END,
            "takeover_actor_kind" = CASE WHEN "takeover_state" = 'HUMAN_ACTIVE' THEN "takeover_actor_kind" ELSE 'NATIVE_APP'::"ActorKind" END,
            "takeover_actor_user_id" = CASE WHEN "takeover_state" = 'HUMAN_ACTIVE' THEN "takeover_actor_user_id" ELSE NULL END,
            "takeover_paused_until" = GREATEST(COALESCE("takeover_paused_until", ${pausedUntil}), ${pausedUntil}),
            "takeover_review_mode" = NULL,
            "takeover_state" = 'HUMAN_ACTIVE'::"TakeoverState",
            "updated_at" = now()
        WHERE "workspace_id" = ${workspaceId} AND "id" = ${conversationId}`;
    },

    async findMessageByPlatformId({ workspaceId, channelAccountId, platformMessageId }) {
      const message = await tx.message.findUnique({
        where: {
          workspaceId_channelAccountId_channelMessageId: { workspaceId, channelAccountId, channelMessageId: platformMessageId },
        },
        select: { id: true, deliveryStatus: true },
      });
      return message === null ? undefined : { messageId: message.id, deliveryStatus: message.deliveryStatus };
    },

    async updateMessageDeliveryStatus({ workspaceId, messageId, deliveryStatus, occurredAt }) {
      await tx.message.update({
        where: { workspaceId_id: { workspaceId, id: messageId } },
        data: {
          deliveryStatus,
          ...(deliveryStatus === "DELIVERED" || deliveryStatus === "READ" ? { deliveredAt: occurredAt } : {}),
          ...(deliveryStatus === "READ" ? { readAt: occurredAt } : {}),
        },
      });
    },

    async addOutboxEntry(input) {
      const created = await tx.queueOutbox.createManyAndReturn({
        data: [
          {
            workspaceId: input.workspaceId,
            kind: input.kind,
            dedupeKey: input.dedupeKey,
            correlationId: input.correlationId,
            payload: { ...input.payload },
            delayMs: input.delayMs,
          },
        ],
        skipDuplicates: true,
        select: { id: true },
      });
      return created[0] === undefined ? undefined : { id: created[0].id };
    },
  };
}
