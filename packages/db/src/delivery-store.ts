/**
 * PostgreSQL implementation of the delivery coordinator's `DeliveryStore` (ADR-012).
 *
 * The whole point of this file is one statement: the claim. Two workers can hold the same queue job — a
 * lost lock, a restart, a duplicate enqueue — and both will reach this code believing they should send. The
 * database decides which of them is right, with a conditional `UPDATE` that can only succeed once:
 *
 *     UPDATE delivery_jobs SET status = 'SENDING' WHERE operation_id = $1 AND status = 'SCHEDULED'
 *
 * No read-then-write, no application-side check, nothing a race can slip between. The loser sees zero rows
 * and stops — before the adapter, not after it.
 *
 * Delivery is a system flow driven by a queue job, so the scope comes from the job's own row rather than
 * from a member context, exactly as for ingestion and draft generation. Every statement is still bounded by
 * the operation ID, which is unique across the table.
 */
import type { DeliverySendContext, DeliverySettlement, DeliveryStore } from "@omnichannel/application";
import { randomUUID } from "node:crypto";

import type { DeliveryJobStatus } from "@omnichannel/domain";

import type { DbClient } from "./client";

/** States a scheduled delivery may still be claimed from. Anything else is finished or in flight. */
const CLAIMABLE: DeliveryJobStatus = "SCHEDULED";

export function createDeliveryStore(db: DbClient): DeliveryStore {
  return {
    async loadForSend(operationId) {
      const job = await db.deliveryJobRecord.findUnique({
        where: { operationId },
        select: {
          id: true,
          operationId: true,
          draftId: true,
          status: true,
          attemptCount: true,
          workspaceId: true,
          businessProfileId: true,
          draft: {
            select: {
              text: true,
              needsReview: true,
              conversationId: true,
              sentMessage: { select: { id: true } },
              conversation: {
                select: {
                  id: true,
                  channelAccountId: true,
                  status: true,
                  aiEnabled: true,
                  takeoverState: true,
                  modeOverride: true,
                  // The conversation reaches its account through the identity's composite key.
                  channelIdentity: { select: { externalUserId: true, channelAccount: { select: { channel: true, status: true } } } },
                },
              },
            },
          },
        },
      });
      if (job === null) {
        return undefined;
      }

      const conversation = job.draft.conversation;
      const scope = { workspaceId: job.workspaceId, businessProfileId: job.businessProfileId };
      // Read here rather than carried from scheduling: a message that arrived during the delay is exactly
      // the thing this lookup exists to notice.
      const newerInbound = await db.message.findFirst({
        where: { ...scope, conversationId: conversation.id, direction: "IN", aiDraftId: null, occurredAt: { gt: await anchorTime(db, scope, job.draftId) } },
        select: { id: true },
      });

      const context: DeliverySendContext = {
        deliveryJobId: job.id,
        operationId: job.operationId,
        draftId: job.draftId,
        conversationId: conversation.id,
        channel: conversation.channelIdentity.channelAccount.channel,
        recipientExternalId: conversation.channelIdentity.externalUserId,
        channelAccountId: conversation.channelAccountId,
        ...(job.draft.text === null ? {} : { text: job.draft.text }),
        status: job.status,
        attemptCount: job.attemptCount,
        mode: await resolveMode(db, scope, conversation.channelAccountId, conversation.modeOverride),
        aiEnabled: conversation.aiEnabled && conversation.status === "OPEN",
        takeover: takeoverStateOf(conversation.takeoverState),
        replyCycle: newerInbound === null ? "OWNED" : "SUPERSEDED",
        account: conversation.channelIdentity.channelAccount.status,
        draftNeedsReview: job.draft.needsReview,
        // The draft's own sent message is the durable record that the logical action already happened.
        alreadySent: job.draft.sentMessage !== null,
      };
      return context;
    },

    async claim(operationId, claimedAt) {
      // One conditional UPDATE. The `status` predicate is the entire concurrency control: whichever
      // transaction commits first flips the row, and the other matches zero rows.
      const claimed = await db.deliveryJobRecord.updateMany({
        where: { operationId, status: CLAIMABLE },
        data: { status: "SENDING", claimedAt, attemptCount: { increment: 1 } },
      });
      if (claimed.count === 1) {
        return { kind: "CLAIMED" };
      }
      const current = await db.deliveryJobRecord.findUnique({ where: { operationId }, select: { status: true } });
      return { kind: "NOT_CLAIMABLE", status: current?.status ?? "SENT" };
    },

    async settle(operationId, settlement, at) {
      await db.$transaction(async (tx) => {
        const job = await tx.deliveryJobRecord.findUniqueOrThrow({
          where: { operationId },
          select: { id: true, workspaceId: true, businessProfileId: true, draftId: true, correlationId: true, draft: { select: { conversationId: true, conversation: { select: { channelAccountId: true } } } } },
        });
        const scope = { workspaceId: job.workspaceId, businessProfileId: job.businessProfileId };

        if (settlement.kind === "SENT") {
          // The outbound message and the terminal state are written together: a SENT row without its
          // message would let a later run believe nothing had been sent.
          await tx.message.create({
            data: {
              ...scope,
              channelAccountId: job.draft.conversation.channelAccountId,
              conversationId: job.draft.conversationId,
              channelMessageId: settlement.platformMessageId === "" ? null : settlement.platformMessageId,
              direction: "OUT",
              source: "AI",
              kind: "TEXT",
              occurredAt: at,
              deliveryStatus: "SENT",
              // Automated delivery is always the standard path; the human-agent path is a human action.
              transportPath: "STANDARD",
              operationId,
              aiDraftId: job.draftId,
            },
          });
          await tx.conversation.update({
            where: { workspaceId_businessProfileId_id: { ...scope, id: job.draft.conversationId } },
            data: { lastOutboundAt: at, lastMessageAt: at },
          });
        }

        await tx.deliveryJobRecord.update({ where: { operationId }, data: statusFieldsFor(settlement, at) });
      });
    },

    async reschedule(operationId, notBefore) {
      // Back to SCHEDULED without counting an attempt: waiting for quiet hours is not a failure.
      await db.deliveryJobRecord.updateMany({
        where: { operationId, status: { in: ["SCHEDULED", "SENDING"] } },
        data: { status: "SCHEDULED", scheduledFor: notBefore, claimedAt: null },
      });
    },
  };
}

/**
 * Quarantines deliveries left in SENDING by a worker that died mid-flight.
 *
 * A claim that outlives its lease proves nothing about whether the platform received the message, so these
 * are never re-run. They become `HELD_AMBIGUOUS` — the same state a reported ambiguity produces — because
 * "we do not know" is the honest answer in both cases and it is the one that keeps a duplicate reply out of
 * the customer's inbox (ADR-012).
 */
export async function recoverStaleSendingDeliveries(db: DbClient, leaseMs: number, now: Date): Promise<readonly string[]> {
  const cutoff = new Date(now.getTime() - leaseMs);
  const stale = await db.deliveryJobRecord.findMany({
    where: { status: "SENDING", claimedAt: { lt: cutoff } },
    select: { operationId: true },
  });
  if (stale.length === 0) {
    return [];
  }
  await db.deliveryJobRecord.updateMany({
    where: { operationId: { in: stale.map((job) => job.operationId) }, status: "SENDING", claimedAt: { lt: cutoff } },
    data: { status: "HELD_AMBIGUOUS", lastErrorCode: "DELIVERY_STALLED", lastErrorMessage: "the worker holding this send did not finish" },
  });
  return stale.map((job) => job.operationId);
}

function statusFieldsFor(settlement: DeliverySettlement, at: Date) {
  switch (settlement.kind) {
    case "SENT":
      return { status: "SENT" as const, sentAt: at, platformMessageId: settlement.platformMessageId, providerRequestId: settlement.providerRequestId ?? null };
    case "CANCELLED":
      return { status: settlement.status, cancelledAt: at, cancelReason: settlement.reasons.join(",") };
    case "HELD":
      return { status: settlement.status, lastErrorCode: settlement.code ?? null, lastErrorMessage: settlement.message };
    case "RETRY":
      // Returned to the claimable state so the queue's next attempt can take it; the attempt count already
      // advanced when this one was claimed.
      return { status: "SCHEDULED" as const, claimedAt: null, lastErrorCode: settlement.code ?? null, lastErrorMessage: settlement.message };
    case "EXHAUSTED":
      return { status: "FAILED_RETRYABLE_EXHAUSTED" as const, lastErrorCode: settlement.code ?? null, lastErrorMessage: settlement.message };
  }
}

function takeoverStateOf(state: string): DeliverySendContext["takeover"] {
  if (state === "HUMAN_ACTIVE") {
    return { state: "HUMAN_ACTIVE", reason: "HUMAN_CLAIMED", since: new Date(0) };
  }
  return state === "REVIEW_REQUIRED" ? { state: "REVIEW_REQUIRED", reason: "MANDATORY_REVIEW", reviewMode: "NORMAL", since: new Date(0) } : { state: "NONE" };
}

async function anchorTime(db: DbClient, scope: { workspaceId: string; businessProfileId: string }, draftId: string): Promise<Date> {
  const draft = await db.aiDraft.findUniqueOrThrow({
    where: { workspaceId_businessProfileId_id: { ...scope, id: draftId } },
    select: { anchorMessage: { select: { occurredAt: true } } },
  });
  return draft.anchorMessage.occurredAt;
}

/** Conversation override, then a channel-account policy, then the Business Profile default, then OFF. */
async function resolveMode(
  db: DbClient,
  scope: { workspaceId: string; businessProfileId: string },
  channelAccountId: string,
  override: string | null,
): Promise<DeliverySendContext["mode"]> {
  if (override !== null) {
    return override as DeliverySendContext["mode"];
  }
  const policies = await db.automationPolicy.findMany({
    where: { ...scope, OR: [{ channelAccountId }, { channelAccountId: null }] },
    select: { channelAccountId: true, mode: true },
  });
  return policies.find((policy) => policy.channelAccountId === channelAccountId)?.mode ?? policies.find((policy) => policy.channelAccountId === null)?.mode ?? "OFF";
}

export interface AutomatedDeliveryInput {
  readonly workspaceId: string;
  readonly businessProfileId: string;
  readonly draftId: string;
  readonly correlationId: string;
  readonly delayMs: number;
  readonly now: Date;
}

/**
 * Creates the durable delivery row for a draft automation approved (#16).
 *
 * The chosen delay and the intended send time are persisted *before* anything is enqueued, so a queue that
 * loses the job still leaves a record of what was supposed to happen and when. The unique index on
 * `(workspace, profile, draft)` is what makes a repeated call return the existing operation instead of
 * creating a second logical send.
 */
export async function scheduleAutomatedDelivery(db: DbClient, input: AutomatedDeliveryInput): Promise<{ readonly operationId: string; readonly scheduledFor: Date }> {
  const scope = { workspaceId: input.workspaceId, businessProfileId: input.businessProfileId };
  const existing = await db.deliveryJobRecord.findUnique({
    where: { workspaceId_businessProfileId_draftId: { ...scope, draftId: input.draftId } },
    select: { operationId: true, scheduledFor: true },
  });
  if (existing !== null) {
    return existing;
  }
  const scheduledFor = new Date(input.now.getTime() + input.delayMs);
  const operationId = randomUUID();
  await db.$transaction(async (tx) => {
    await tx.deliveryJobRecord.create({
      data: { ...scope, draftId: input.draftId, operationId, correlationId: input.correlationId, status: "SCHEDULED", scheduledFor, selectedDelayMs: input.delayMs },
    });
    await tx.aiDraft.update({ where: { workspaceId_businessProfileId_id: { ...scope, id: input.draftId } }, data: { status: "SCHEDULED" } });
  });
  return { operationId, scheduledFor };
}

/** Marks a conversation as waiting for a human decision, without claiming a person has acted. */
export async function requestHumanReview(
  db: DbClient,
  input: { readonly workspaceId: string; readonly businessProfileId: string; readonly conversationId: string; readonly reviewMode: "NORMAL" | "HUMAN_AGENT"; readonly at: Date },
): Promise<void> {
  const scope = { workspaceId: input.workspaceId, businessProfileId: input.businessProfileId };
  await db.conversation.updateMany({
    // Only from NONE: a person already holding the conversation is not demoted by an escalation from
    // automation, which is the state machine's rule expressed as a predicate.
    where: { ...scope, id: input.conversationId, takeoverState: "NONE" },
    data: {
      takeoverState: "REVIEW_REQUIRED",
      takeoverReason: input.reviewMode === "HUMAN_AGENT" ? "HUMAN_AGENT_REVIEW" : "MANDATORY_REVIEW",
      takeoverReviewMode: input.reviewMode,
      humanTakeoverAt: input.at,
    },
  });
}
