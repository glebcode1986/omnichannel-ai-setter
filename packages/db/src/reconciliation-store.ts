/**
 * Persistence for reconciling outbound operations whose outcome is unknown (ADR-012, Issue #56).
 *
 * Every write here is the answer to "what is now true about this send", and each one is a transaction
 * because the delivery job, the draft and the conversation have to agree. A `SENT` delivery with no
 * outbound message would let a later pass conclude nothing was sent and offer to send again — the exact
 * duplicate ADR-012 exists to prevent.
 *
 * There is no resend in this file. `resume` puts the operation back into the claimable state and nothing
 * more; the caller enqueues a delivery job, and the coordinator re-reads and re-judges everything before
 * anything reaches a customer.
 */
import type { OpenReconciliation, ReconciliationRecord, ReconciliationStore, ReconciliationSubject } from "@omnichannel/application";
import { isReconciliationReason, type ReconciliationReason } from "@omnichannel/domain";

import type { DbClient } from "./client";

/** The one state a reconciliation may sit in without having concluded anything. */
const UNRESOLVED = "PENDING" as const;

export function createReconciliationStore(db: DbClient): ReconciliationStore {
  return {
    async open(input: OpenReconciliation) {
      // Created once per operation and never duplicated: a redelivered job updates the investigation it
      // already has. `detectedAt` is deliberately not refreshed — the grace period before a person is
      // told runs from when the ambiguity first appeared, not from the latest retry of the job.
      await db.deliveryReconciliation.upsert({
        where: { operationId: input.operationId },
        create: {
          workspaceId: input.workspaceId,
          businessProfileId: input.businessProfileId,
          operationId: input.operationId,
          deliveryJobId: input.deliveryJobId,
          conversationId: input.conversationId,
          reason: input.reason,
          state: UNRESOLVED,
          detectedAt: input.detectedAt,
          providerRequestId: input.providerRequestId ?? null,
          providerCode: input.providerCode ?? null,
        },
        update: {
          // Only what a later observation can legitimately add. A provider request id that arrives on a
          // second report is new evidence; the first detection time is not something a retry may rewrite.
          ...(input.providerRequestId === undefined ? {} : { providerRequestId: input.providerRequestId }),
          ...(input.providerCode === undefined ? {} : { providerCode: input.providerCode }),
        },
      });
    },

    async load(operationId) {
      const [job, record] = await Promise.all([
        db.deliveryJobRecord.findUnique({
          where: { operationId },
          select: { id: true, status: true, claimedAt: true, attemptCount: true, providerRequestId: true, draft: { select: { conversationId: true } } },
        }),
        db.deliveryReconciliation.findUnique({
          where: { operationId },
          select: { reason: true, detectedAt: true, providerRequestId: true },
        }),
      ]);
      if (job === null || record === null) {
        return undefined;
      }
      const providerRequestId = job.providerRequestId ?? record.providerRequestId;
      const subject: ReconciliationSubject = {
        operationId,
        deliveryJobId: job.id,
        conversationId: job.draft.conversationId,
        status: job.status,
        ...(job.claimedAt === null ? {} : { claimedAt: job.claimedAt }),
        attemptCount: job.attemptCount,
        ...(providerRequestId === null ? {} : { providerRequestId }),
        detectedAt: record.detectedAt,
        reason: record.reason,
      };
      return subject;
    },

    async markSent(operationId, platformMessageId, at) {
      await db.$transaction(async (tx) => {
        const job = await tx.deliveryJobRecord.findUniqueOrThrow({
          where: { operationId },
          select: { workspaceId: true, businessProfileId: true, draftId: true, status: true, draft: { select: { conversationId: true, conversation: { select: { channelAccountId: true } } } } },
        });
        const scope = { workspaceId: job.workspaceId, businessProfileId: job.businessProfileId };
        // Conditional on the ambiguous state, in the database rather than in a prior read: between the
        // load and here, an echo or another reconciliation may already have settled this. Writing a
        // second outbound message for one operation is exactly the duplicate we are avoiding.
        const claimed = await tx.deliveryJobRecord.updateMany({
          where: { operationId, status: { in: ["HELD_AMBIGUOUS", "SENDING"] } },
          data: { status: "SENT", sentAt: at, platformMessageId, claimedAt: null },
        });
        if (claimed.count === 0) {
          return;
        }
        await tx.message.create({
          data: {
            ...scope,
            channelAccountId: job.draft.conversation.channelAccountId,
            conversationId: job.draft.conversationId,
            channelMessageId: platformMessageId === "" ? null : platformMessageId,
            direction: "OUT",
            source: "AI",
            kind: "TEXT",
            occurredAt: at,
            deliveryStatus: "SENT",
            transportPath: "STANDARD",
            operationId,
            aiDraftId: job.draftId,
          },
        });
        await tx.conversation.update({
          where: { workspaceId_businessProfileId_id: { ...scope, id: job.draft.conversationId } },
          data: { lastOutboundAt: at, lastMessageAt: at },
        });
        await tx.aiDraft.update({
          where: { workspaceId_businessProfileId_id: { ...scope, id: job.draftId } },
          data: { status: "SENT" },
        });
      });
    },

    async resume(operationId, at) {
      await db.$transaction(async (tx) => {
        const job = await tx.deliveryJobRecord.findUniqueOrThrow({
          where: { operationId },
          select: { workspaceId: true, businessProfileId: true, draftId: true },
        });
        // Claimable again, and scheduled for now: the coordinator decides on re-read whether this reply
        // still deserves to exist. Nothing here decides that, and nothing here sends.
        const resumed = await tx.deliveryJobRecord.updateMany({
          where: { operationId, status: { in: ["SCHEDULED", "HELD_AMBIGUOUS"] } },
          data: { status: "SCHEDULED", scheduledFor: at, claimedAt: null },
        });
        if (resumed.count === 0) {
          return;
        }
        await tx.aiDraft.updateMany({
          where: { workspaceId: job.workspaceId, businessProfileId: job.businessProfileId, id: job.draftId, status: { in: ["HELD_AMBIGUOUS", "SCHEDULED", "CLAIMED"] } },
          data: { status: "SCHEDULED" },
        });
      });
    },

    async escalate(operationId, detail, at) {
      await db.$transaction(async (tx) => {
        const job = await tx.deliveryJobRecord.findUniqueOrThrow({
          where: { operationId },
          select: { workspaceId: true, businessProfileId: true, draftId: true, draft: { select: { reasonCodes: true } } },
        });
        const scope = { workspaceId: job.workspaceId, businessProfileId: job.businessProfileId };
        await tx.deliveryJobRecord.updateMany({
          where: { operationId, status: { notIn: ["SENT"] } },
          data: { status: "HELD_REVIEW", claimedAt: null, lastErrorMessage: detail },
        });
        // The draft becomes the review item: a person opens the conversation and sees the reply together
        // with the fact that whether it was sent is unknown. `ACCOUNT_UNHEALTHY` is not added here — the
        // account may be perfectly healthy; what is unhealthy is our knowledge of this one operation.
        await tx.aiDraft.update({
          where: { workspaceId_businessProfileId_id: { ...scope, id: job.draftId } },
          data: {
            status: "HELD",
            needsReview: true,
            reasonCodes: job.draft.reasonCodes.includes("REVIEW_PENDING") ? job.draft.reasonCodes : [...job.draft.reasonCodes, "REVIEW_PENDING"],
            updatedAt: at,
          },
        });
      });
    },

    async record(input: ReconciliationRecord) {
      await db.deliveryReconciliation.update({
        where: { operationId: input.operationId },
        data: {
          state: input.state,
          evidence: input.evidence,
          attemptCount: { increment: 1 },
          lastAttemptAt: input.at,
          // Paired with the state by a CHECK constraint: a resolution has a moment, and a moment means
          // it is resolved. Half of that pair is a row nobody can read.
          resolvedAt: input.state === UNRESOLVED ? null : input.at,
        },
      });
    },
  };
}

/** Everything needed to re-raise a reconciliation job for one operation. */
export interface UnresolvedOperation {
  readonly workspaceId: string;
  readonly businessProfileId: string;
  readonly conversationId: string;
  readonly correlationId: string;
  readonly deliveryJobId: string;
  readonly operationId: string;
  readonly reason: ReconciliationReason;
  readonly detectedAt: Date;
  readonly providerRequestId?: string;
}

/**
 * Unresolved operations that nothing is currently working on.
 *
 * Two populations, and the second is the one that matters. The first is ordinary: a reconciliation that
 * asked, could not tell, and is waiting to ask again. The second is an ambiguous delivery with no
 * reconciliation record at all — the job that should have opened one was lost, evicted or never enqueued
 * because Redis was the thing that failed. Without this half, an outage in the queue would leave sends
 * permanently unknown and invisible, which is precisely the failure the audit requirement is about.
 *
 * `detectedAt` for that second population is the delivery row's own `updatedAt`: the moment it became
 * ambiguous. Using "now" instead would restart the grace period on every sweep, and an operation could
 * stay quietly unresolved forever while looking freshly detected each time.
 */
export async function findUnresolvedOperations(
  db: DbClient,
  options: { readonly retryBefore: Date; readonly limit: number },
): Promise<readonly UnresolvedOperation[]> {
  const [pending, orphaned] = await Promise.all([
    db.deliveryReconciliation.findMany({
      where: { state: UNRESOLVED, OR: [{ lastAttemptAt: null }, { lastAttemptAt: { lt: options.retryBefore } }] },
      select: {
        workspaceId: true,
        businessProfileId: true,
        conversationId: true,
        deliveryJobId: true,
        operationId: true,
        reason: true,
        detectedAt: true,
        providerRequestId: true,
        deliveryJob: { select: { correlationId: true } },
      },
      orderBy: { detectedAt: "asc" },
      take: options.limit,
    }),
    db.deliveryJobRecord.findMany({
      where: { status: "HELD_AMBIGUOUS", reconciliation: { is: null } },
      select: {
        workspaceId: true,
        businessProfileId: true,
        correlationId: true,
        id: true,
        operationId: true,
        updatedAt: true,
        lastErrorCode: true,
        draft: { select: { conversationId: true } },
      },
      orderBy: { updatedAt: "asc" },
      take: options.limit,
    }),
  ]);

  return [
    ...pending.map(
      (row) =>
        ({
          workspaceId: row.workspaceId,
          businessProfileId: row.businessProfileId,
          conversationId: row.conversationId,
          correlationId: row.deliveryJob.correlationId,
          deliveryJobId: row.deliveryJobId,
          operationId: row.operationId,
          reason: row.reason,
          detectedAt: row.detectedAt,
          ...(row.providerRequestId === null ? {} : { providerRequestId: row.providerRequestId }),
        }) satisfies UnresolvedOperation,
    ),
    ...orphaned.map(
      (row) =>
        ({
          workspaceId: row.workspaceId,
          businessProfileId: row.businessProfileId,
          conversationId: row.draft.conversationId,
          correlationId: row.correlationId,
          deliveryJobId: row.id,
          operationId: row.operationId,
          // The code the stale-claim sweeper wrote when it quarantined this, when there is one.
          reason: isReconciliationReason(row.lastErrorCode) ? row.lastErrorCode : "AMBIGUOUS_SEND_RESULT",
          detectedAt: row.updatedAt,
        }) satisfies UnresolvedOperation,
    ),
  ];
}
