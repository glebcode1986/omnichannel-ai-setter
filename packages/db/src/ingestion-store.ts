/**
 * PostgreSQL implementation of the application's ingestion ports. Webhook ingestion is a system flow: the
 * Workspace and Business Profile come from the resolved channel account (never from the URL or payload),
 * and every query stays scoped to that Workspace, Business Profile and account; the composite foreign keys
 * reject rows that would cross them. Idempotency relies on unique constraints with ON CONFLICT DO NOTHING
 * (`skipDuplicates`), so concurrent deliveries of the same event never abort a transaction.
 */
import type {
  InboundDebouncePayload,
  IngestionStore,
  IngestionTransaction,
  OutboxEntry,
  WebhookAccount,
} from "@omnichannel/application";

import { isMessageDeliveryStatus } from "@omnichannel/domain";

import type { DbClient } from "./client";
import type { Prisma } from "./generated/prisma/client";

type TransactionClient = Prisma.TransactionClient;

const TRANSACTION_TIMEOUT_MS = 10_000;

export function createIngestionStore(db: DbClient): IngestionStore {
  return {
    async findWebhookAccount(channel, channelAccountId): Promise<WebhookAccount | undefined> {
      const account = await db.channelAccount.findFirst({
        where: { id: channelAccountId, channel },
        select: { id: true, workspaceId: true, businessProfileId: true, channel: true, status: true, externalAccountId: true },
      });
      return account === null
        ? undefined
        : {
            workspaceId: account.workspaceId,
            businessProfileId: account.businessProfileId,
            channelAccountId: account.id,
            channel: account.channel,
            status: account.status,
            externalAccountId: account.externalAccountId,
          };
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
            businessProfileId: entry.businessProfileId,
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

/** Scoped raw updates must hit exactly the one conversation of the resolved Business Profile. */
function expectOneConversation(count: number): void {
  if (count !== 1) {
    throw new Error(`expected one conversation in the resolved Business Profile, updated ${String(count)}`);
  }
}

function createTransaction(tx: TransactionClient): IngestionTransaction {
  return {
    async claimSourceEvent(event) {
      const { count } = await tx.inboundEvent.createMany({
        data: [
          {
            workspaceId: event.workspaceId,
            businessProfileId: event.businessProfileId,
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
          workspaceId_businessProfileId_channelAccountId_sourceEventId: {
            workspaceId: event.workspaceId,
            businessProfileId: event.businessProfileId,
            channelAccountId: event.channelAccountId,
            sourceEventId: event.sourceEventId,
          },
        },
        data: { outcome: event.outcome, processedAt: new Date() },
      });
    },

    async ensureChannelIdentity(input) {
      const scope = { workspaceId: input.workspaceId, businessProfileId: input.businessProfileId };
      const key = {
        workspaceId_businessProfileId_channelAccountId_externalUserId: {
          ...scope,
          channelAccountId: input.channelAccountId,
          externalUserId: input.externalUserId,
        },
      };
      const select = { id: true, contactId: true, displayName: true, username: true } as const;
      const existing = await tx.channelIdentity.findUnique({ where: key, select });
      if (existing !== null) {
        const displayName = input.displayName ?? existing.displayName;
        const username = input.username ?? existing.username;
        if (displayName !== existing.displayName || username !== existing.username) {
          // Profile fields are refreshed only; they never identify the participant or change conversation state.
          await tx.channelIdentity.update({ where: key, data: { displayName, username } });
        }
        return { channelIdentityId: existing.id, contactId: existing.contactId };
      }

      // Contacts are canonical per Business Profile: the same provider user in another profile is another contact.
      const contact = await tx.contact.create({ data: { ...scope, displayName: input.displayName }, select: { id: true } });
      const created = await tx.channelIdentity.createManyAndReturn({
        data: [
          {
            ...scope,
            contactId: contact.id,
            channelAccountId: input.channelAccountId,
            externalUserId: input.externalUserId,
            displayName: input.displayName,
            username: input.username,
          },
        ],
        skipDuplicates: true,
        select: { id: true, contactId: true },
      });
      if (created[0] !== undefined) {
        return { channelIdentityId: created[0].id, contactId: created[0].contactId };
      }
      // A concurrent ingestion created the identity first: drop our unused contact and use theirs.
      await tx.contact.delete({ where: { workspaceId_businessProfileId_id: { ...scope, id: contact.id } } });
      const winner = await tx.channelIdentity.findUniqueOrThrow({ where: key, select: { id: true, contactId: true } });
      return { channelIdentityId: winner.id, contactId: winner.contactId };
    },

    async ensureConversation(input) {
      const scope = { workspaceId: input.workspaceId, businessProfileId: input.businessProfileId };
      const key = {
        workspaceId_businessProfileId_channelAccountId_channelIdentityId: {
          ...scope,
          channelAccountId: input.channelAccountId,
          channelIdentityId: input.channelIdentityId,
        },
      };
      await tx.conversation.createMany({
        data: [
          {
            ...scope,
            channelAccountId: input.channelAccountId,
            contactId: input.contactId,
            channelIdentityId: input.channelIdentityId,
          },
        ],
        skipDuplicates: true,
      });
      const conversation = await tx.conversation.findUniqueOrThrow({
        where: key,
        select: { id: true, contactId: true, stateVersion: true, status: true, aiEnabled: true, takeoverState: true },
      });
      return {
        conversationId: conversation.id,
        contactId: conversation.contactId,
        stateVersion: conversation.stateVersion,
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
            businessProfileId: input.businessProfileId,
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

    async recordActivity({ workspaceId, businessProfileId, conversationId, direction, occurredAt }) {
      // A new participant or human message is a material change: anchored drafts/reviews become stale.
      const count =
        direction === "IN"
          ? await tx.$executeRaw`
              UPDATE "conversations"
              SET "last_inbound_at" = GREATEST(COALESCE("last_inbound_at", ${occurredAt}), ${occurredAt}),
                  "last_message_at" = GREATEST("last_message_at", ${occurredAt}),
                  "state_version" = "state_version" + 1,
                  "updated_at" = now()
              WHERE "workspace_id" = ${workspaceId} AND "business_profile_id" = ${businessProfileId} AND "id" = ${conversationId}`
          : await tx.$executeRaw`
              UPDATE "conversations"
              SET "last_outbound_at" = GREATEST(COALESCE("last_outbound_at", ${occurredAt}), ${occurredAt}),
                  "last_message_at" = GREATEST("last_message_at", ${occurredAt}),
                  "state_version" = "state_version" + 1,
                  "updated_at" = now()
              WHERE "workspace_id" = ${workspaceId} AND "business_profile_id" = ${businessProfileId} AND "id" = ${conversationId}`;
      expectOneConversation(count);
    },

    async isAppOriginatedMessage({ workspaceId, businessProfileId, channelAccountId, platformMessageId }) {
      const message = await tx.message.findFirst({
        where: {
          workspaceId,
          businessProfileId,
          channelAccountId,
          channelMessageId: platformMessageId,
          direction: "OUT",
          operationId: { not: null },
        },
        select: { id: true },
      });
      if (message !== null) {
        return true;
      }
      // The send result may be recorded on the delivery job before the outbound message row exists.
      const job = await tx.deliveryJobRecord.findFirst({
        where: { workspaceId, businessProfileId, platformMessageId, draft: { conversation: { channelAccountId } } },
        select: { id: true },
      });
      return job !== null;
    },

    async startHumanTakeover({ workspaceId, businessProfileId, conversationId, since, pausedUntil }) {
      // A new manual outbound extends an existing human takeover; otherwise it starts one (HUMAN_HANDOFF.md).
      // The state version was already advanced once for this message by recordActivity.
      const count = await tx.$executeRaw`
        UPDATE "conversations"
        SET "takeover_reason" = CASE WHEN "takeover_state" = 'HUMAN_ACTIVE' THEN "takeover_reason" ELSE 'UNMATCHED_OUTBOUND_ECHO'::"TakeoverReason" END,
            "human_takeover_at" = CASE WHEN "takeover_state" = 'HUMAN_ACTIVE' THEN "human_takeover_at" ELSE ${since} END,
            "takeover_actor_kind" = CASE WHEN "takeover_state" = 'HUMAN_ACTIVE' THEN "takeover_actor_kind" ELSE 'NATIVE_APP'::"ActorKind" END,
            "takeover_actor_user_id" = CASE WHEN "takeover_state" = 'HUMAN_ACTIVE' THEN "takeover_actor_user_id" ELSE NULL END,
            "takeover_paused_until" = GREATEST(COALESCE("takeover_paused_until", ${pausedUntil}), ${pausedUntil}),
            "takeover_review_mode" = NULL,
            "takeover_state" = 'HUMAN_ACTIVE'::"TakeoverState",
            "updated_at" = now()
        WHERE "workspace_id" = ${workspaceId} AND "business_profile_id" = ${businessProfileId} AND "id" = ${conversationId}`;
      expectOneConversation(count);
    },

    async findMessageByPlatformId({ workspaceId, businessProfileId, channelAccountId, platformMessageId }) {
      // Row lock: a concurrent status event for the same message waits and then reads this one's result, so
      // statuses only move forward (READ is never overwritten by a DELIVERED computed from an older read).
      const rows = await tx.$queryRaw<{ id: string; delivery_status: string | null }[]>`
        SELECT "id", "delivery_status"::text AS "delivery_status"
        FROM "messages"
        WHERE "workspace_id" = ${workspaceId}
          AND "business_profile_id" = ${businessProfileId}
          AND "channel_account_id" = ${channelAccountId}
          AND "channel_message_id" = ${platformMessageId}
        FOR UPDATE`;
      const message = rows[0];
      if (message === undefined) {
        return undefined;
      }
      const deliveryStatus = message.delivery_status;
      if (deliveryStatus !== null && !isMessageDeliveryStatus(deliveryStatus)) {
        throw new Error("unexpected message delivery status");
      }
      return { messageId: message.id, deliveryStatus };
    },

    async updateMessageDeliveryStatus({ workspaceId, businessProfileId, messageId, deliveryStatus, occurredAt }) {
      await tx.message.update({
        where: { workspaceId_businessProfileId_id: { workspaceId, businessProfileId, id: messageId } },
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
            businessProfileId: input.businessProfileId,
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
