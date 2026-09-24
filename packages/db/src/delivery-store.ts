/**
 * PostgreSQL implementation of the delivery coordinator's `DeliveryStore` (ADR-012).
 *
 * The whole point of this file is one statement: the claim. Two workers can hold the same queue job — a
 * lost lock, a restart, a duplicate enqueue — and both will reach this code believing they should send. The
 * database decides which of them is right, with a conditional `UPDATE` that can only succeed once.
 *
 * The condition is not only the delivery row's own status. Between the read that approved this send and the
 * claim that takes it, the conversation can move: the customer writes again, a colleague takes over, the
 * business edits its automation policy or switches AI off. A claim conditional only on `status = 'SCHEDULED'`
 * succeeds in every one of those cases and sends on an approval that has already expired — the row was never
 * the thing that authorized the send.
 *
 * So the claim asserts, in the same statement, every fact the approval rested on:
 *
 *     UPDATE delivery_jobs SET status = 'SENDING'
 *      WHERE operation_id = $1 AND status = 'SCHEDULED'
 *        AND <the draft, conversation, account and policy are still exactly as they were read>
 *
 * One statement, so there is no read-then-write for a race to slip between, and no application-side check
 * that a concurrent commit could invalidate a microsecond later. A loser — whether it lost to another worker
 * or to the customer — sees zero rows and stops, before the adapter rather than after it.
 *
 * The facts are re-asserted rather than compared against a single version counter. A counter only protects
 * what its writers remember to bump; every value here is checked against what was actually read, so a writer
 * that changes one of them cannot leave the guard behind.
 *
 * Delivery is a system flow driven by a queue job, so the scope comes from the job's own row rather than
 * from a member context, exactly as for ingestion and draft generation. Every statement is still bounded by
 * the operation ID, which is unique across the table.
 */
import type { DeliverySendContext, DeliveryStateGuard, DeliverySettlement, DeliveryStore } from "@omnichannel/application";
import type { DeliveryJobStatus } from "@omnichannel/domain";

import type { DbClient } from "./client";
import type { AiMode, ChannelAccountStatus, ConversationStatus, TakeoverState } from "./generated/prisma/enums";

/** States a scheduled delivery may still be claimed from. Anything else is finished or in flight. */
const CLAIMABLE: DeliveryJobStatus = "SCHEDULED";

/**
 * The live facts a send was judged against, as the claim must find them again.
 *
 * Opaque to the coordinator by design (`DeliveryStateGuard`): it carries this back untouched, and only the
 * claim's own statement may act on it. Everything the coordinator judges is derived from one of these, so a
 * field that stops being asserted here is a way for a decision to be made on a fact that has since changed.
 */
interface SendStateGuard {
  readonly channelAccountId: string;
  /** Advanced by every new customer message, and by any future writer of conversation-level state. */
  readonly conversationStateVersion: number;
  readonly conversationStatus: ConversationStatus;
  readonly takeoverState: TakeoverState;
  readonly aiEnabled: boolean;
  readonly modeOverride: AiMode | null;
  readonly accountStatus: ChannelAccountStatus;
  readonly draftText: string | null;
  readonly draftNeedsReview: boolean;
  /** The draft's anchor: a customer message after it is what makes this reply answer a stale question. */
  readonly anchorAt: Date;
  /**
   * When the automation policy rows were last written, or null where none exists.
   *
   * The mode, the confidence threshold, quiet hours and the after-window policy all come from these rows,
   * and the limits the coordinator judges against were read from them too. `updatedAt` is the one field that
   * answers "is this still the row that was read?" for all of it at once.
   */
  readonly accountPolicyAt: Date | null;
  readonly defaultPolicyAt: Date | null;
}

const sealGuard = (guard: SendStateGuard): DeliveryStateGuard => guard as unknown as DeliveryStateGuard;
const openGuard = (guard: DeliveryStateGuard): SendStateGuard => guard as unknown as SendStateGuard;

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
                  stateVersion: true,
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
      const anchorAt = await anchorTime(db, scope, job.draftId);
      // Read here rather than carried from scheduling: a message that arrived during the delay is exactly
      // the thing this lookup exists to notice.
      const newerInbound = await db.message.findFirst({
        where: { ...scope, conversationId: conversation.id, direction: "IN", aiDraftId: null, occurredAt: { gt: anchorAt } },
        select: { id: true },
      });
      const policies = await automationPolicies(db, scope, conversation.channelAccountId);

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
        mode: resolveMode(policies, conversation.modeOverride),
        aiEnabled: conversation.aiEnabled && conversation.status === "OPEN",
        takeover: takeoverStateOf(conversation.takeoverState),
        replyCycle: newerInbound === null ? "OWNED" : "SUPERSEDED",
        account: conversation.channelIdentity.channelAccount.status,
        draftNeedsReview: job.draft.needsReview,
        // The draft's own sent message is the durable record that the logical action already happened.
        alreadySent: job.draft.sentMessage !== null,
        guard: sealGuard({
          channelAccountId: conversation.channelAccountId,
          conversationStateVersion: conversation.stateVersion,
          conversationStatus: conversation.status,
          takeoverState: conversation.takeoverState,
          aiEnabled: conversation.aiEnabled,
          modeOverride: conversation.modeOverride,
          accountStatus: conversation.channelIdentity.channelAccount.status,
          draftText: job.draft.text,
          draftNeedsReview: job.draft.needsReview,
          anchorAt,
          accountPolicyAt: policies.account?.updatedAt ?? null,
          defaultPolicyAt: policies.default?.updatedAt ?? null,
        }),
      };
      return context;
    },

    async claim(context, claimedAt) {
      const guard = openGuard(context.guard);
      // One conditional UPDATE, and every predicate in it is part of the concurrency control: the status
      // decides which worker wins, and the rest decides whether the approval is still the live state.
      // Whichever transaction commits first flips the row; anything else matches zero rows.
      const claimed = await db.deliveryJobRecord.updateMany({
        where: {
          operationId: context.operationId,
          status: CLAIMABLE,
          draft: {
            text: guard.draftText,
            needsReview: guard.draftNeedsReview,
            // Not merely "was not sent when we read": not sent *now*, checked as the send is taken.
            sentMessage: { is: null },
            conversation: {
              stateVersion: guard.conversationStateVersion,
              status: guard.conversationStatus,
              takeoverState: guard.takeoverState,
              aiEnabled: guard.aiEnabled,
              modeOverride: guard.modeOverride,
              // The reply-cycle fact itself, not a proxy for it: a customer message after the anchor means
              // this reply answers a question that has moved on, whatever any version counter says.
              messages: { none: { direction: "IN", aiDraftId: null, occurredAt: { gt: guard.anchorAt } } },
              channelIdentity: {
                channelAccount: {
                  status: guard.accountStatus,
                  businessProfile: {
                    AND: [
                      policyUnchanged(guard.channelAccountId, guard.accountPolicyAt),
                      policyUnchanged(null, guard.defaultPolicyAt),
                    ],
                  },
                },
              },
            },
          },
        },
        data: { status: "SENDING", claimedAt, attemptCount: { increment: 1 } },
      });
      if (claimed.count === 1) {
        return { kind: "CLAIMED" };
      }

      // Zero rows has two causes worth telling apart, and the row's own status separates them: still
      // claimable means the state moved under this worker, anything else means the delivery is not its to
      // take. Neither sends, so a race between this read and the update above can only mislabel a refusal.
      const current = await db.deliveryJobRecord.findUnique({ where: { operationId: context.operationId }, select: { status: true } });
      if (current === null) {
        return { kind: "NOT_CLAIMABLE", status: "SENT" };
      }
      return current.status === CLAIMABLE ? { kind: "STATE_CHANGED" } : { kind: "NOT_CLAIMABLE", status: current.status };
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

interface PolicyRow {
  readonly mode: AiMode;
  readonly updatedAt: Date;
}

/** The two rows a conversation's automation can come from: its own account's, and the profile default. */
async function automationPolicies(
  db: DbClient,
  scope: { workspaceId: string; businessProfileId: string },
  channelAccountId: string,
): Promise<{ readonly account?: PolicyRow; readonly default?: PolicyRow }> {
  const rows = await db.automationPolicy.findMany({
    where: { ...scope, OR: [{ channelAccountId }, { channelAccountId: null }] },
    select: { channelAccountId: true, mode: true, updatedAt: true },
  });
  return {
    account: rows.find((row) => row.channelAccountId === channelAccountId),
    default: rows.find((row) => row.channelAccountId === null),
  };
}

/** Conversation override, then a channel-account policy, then the Business Profile default, then OFF. */
function resolveMode(
  policies: { readonly account?: PolicyRow; readonly default?: PolicyRow },
  override: AiMode | null,
): DeliverySendContext["mode"] {
  if (override !== null) {
    return override;
  }
  return policies.account?.mode ?? policies.default?.mode ?? "OFF";
}

/**
 * "The policy row this send was judged against has not been written since."
 *
 * Absence is asserted as carefully as presence: a profile that had no override when the decision was made
 * and has one now is a changed decision, and `none` is what says so.
 */
function policyUnchanged(channelAccountId: string | null, updatedAt: Date | null) {
  return updatedAt === null
    ? { automationPolicies: { none: { channelAccountId } } }
    : { automationPolicies: { some: { channelAccountId, updatedAt } } };
}
