/**
 * PostgreSQL implementation of the conversation operations a person can take (HUMAN_HANDOFF.md, #29).
 *
 * The same shape as the review store, for the same reasons: every operation is one transaction, scoped by
 * an authorized `BusinessProfileContext`, and attributed to that context's own authenticated user rather
 * than to anyone a caller names. A caller that could name somebody else could hand a colleague ownership
 * of a conversation they never touched.
 *
 * Cancelling is the one with a race in it. The worker claims a delivery by moving it out of `SCHEDULED`,
 * so cancelling is a conditional update *from* `SCHEDULED` — and if it matches nothing, the row is read
 * back to say which it was: already cancelled (nothing to do, and nothing wrong) or already claimed (the
 * send may be at the provider right now, and ADR-012 forbids guessing about its outcome). Those two need
 * different words on screen, so they are different answers here.
 */
import type { ConversationOperationStore } from "@omnichannel/application";

import type { DbClient, DbExecutor } from "./client";
import { deliveryOfConversation } from "./delivery-origin";
import { cancelPendingFollowUps } from "./followup-store";
import { profileScopeOf, type BusinessProfileContext } from "./tenancy";

/** The conversation belongs to this person from now on, with any earlier auto-resume deadline cleared. */
function humanOwnership(userId: string, at: Date) {
  return {
    takeoverState: "HUMAN_ACTIVE",
    takeoverReason: "HUMAN_CLAIMED",
    takeoverReviewMode: null,
    humanTakeoverAt: at,
    takeoverActorKind: "USER",
    takeoverActorUserId: userId,
    // A fresh human action clears an earlier deadline rather than inheriting it: they are here now.
    takeoverPausedUntil: null,
  } as const;
}

export function createConversationOperationStore(db: DbClient, context: BusinessProfileContext): ConversationOperationStore {
  const scope = profileScopeOf(context);
  const conversationKey = (conversationId: string) => ({ workspaceId_businessProfileId_id: { ...scope, id: conversationId } });

  /** `undefined` when the conversation is not this profile's — which a caller renders as "gone". */
  const conversationExists = async (tx: DbExecutor, conversationId: string): Promise<boolean> =>
    (await tx.conversation.findUnique({ where: conversationKey(conversationId), select: { id: true } })) !== null;

  return {
    async takeOver({ conversationId, at }) {
      return db.$transaction(async (tx) => {
        if (!(await conversationExists(tx, conversationId))) {
          return { status: "GONE" };
        }
        await tx.conversation.update({ where: conversationKey(conversationId), data: humanOwnership(context.userId, at) });
        // A person is handling this conversation now, so automation does not interrupt them — and a
        // pending follow-up is automation with a timer on it (#55). Cancelled in the same transaction as
        // the takeover, so there is no instant at which the conversation is held and a chase is still
        // scheduled. `claimFollowUp` would refuse it too; this is the prompt path.
        await cancelPendingFollowUps(tx, scope, conversationId, "HUMAN_TAKEOVER", at);
        // Idempotent by construction: taking a conversation you already hold writes the same row, and
        // cancelling follow-ups that are already cancelled changes nothing.
        return { status: "TAKEN_OVER" };
      });
    },

    async handBack({ conversationId, at, pauseUntil }) {
      return db.$transaction(async (tx) => {
        if (!(await conversationExists(tx, conversationId))) {
          return { status: "GONE" };
        }
        await tx.conversation.update({
          where: conversationKey(conversationId),
          data:
            pauseUntil === undefined
              ? {
                  takeoverState: "NONE",
                  takeoverReason: null,
                  takeoverReviewMode: null,
                  humanTakeoverAt: null,
                  takeoverPausedUntil: null,
                  takeoverActorKind: null,
                  takeoverActorUserId: null,
                }
              : {
                  // A timed hand-back keeps the takeover and records when automation may resume. The
                  // conversation is still held until then, which is what "pause" means — dropping the
                  // takeover now and trusting the deadline would let the next draft go out immediately.
                  takeoverState: "HUMAN_ACTIVE",
                  takeoverReason: "HUMAN_CLAIMED",
                  takeoverReviewMode: null,
                  humanTakeoverAt: at,
                  takeoverActorKind: "USER",
                  takeoverActorUserId: context.userId,
                  takeoverPausedUntil: pauseUntil,
                },
        });
        return { status: "HANDED_BACK" };
      });
    },

    async cancelSend({ conversationId, operationId, at }) {
      return db.$transaction(async (tx) => {
        // Scoped by the conversation *and* the profile: an operation id from elsewhere must not be
        // cancellable by naming a conversation here, or one tenant could stop another's sends.
        const job = await tx.deliveryJobRecord.findFirst({
          // Both legal origins, matched the same way: a person's own reply names the conversation
          // directly and has no draft, and refusing to find it would leave them unable to stop a send
          // this method exists to stop.
          where: { ...scope, operationId, ...deliveryOfConversation(conversationId) },
          select: { status: true },
        });
        if (job === null) {
          return { status: "GONE" };
        }

        const stopped = await tx.deliveryJobRecord.updateMany({
          where: { ...scope, operationId, status: "SCHEDULED" },
          data: {
            // A person stopping a queued reply is human activity taking the conversation, which is what
            // this status already means. Inventing a new one would leave every existing reader of a
            // cancelled delivery with a value it does not know.
            status: "CANCELLED_HUMAN_TAKEOVER",
            cancelledAt: at,
            cancelReason: "HUMAN_CANCELLED_FROM_INBOX",
          },
        });

        if (stopped.count === 0) {
          // Nothing moved, so the row had already left SCHEDULED — possibly between the read above and
          // this update, which is the race this whole method exists to lose safely. The status is read
          // again rather than reusing the first one: reporting the stale value would tell someone their
          // send is still queued at the exact moment a worker took it.
          const current = await tx.deliveryJobRecord.findFirst({ where: { ...scope, operationId }, select: { status: true } });
          if (current === null) {
            return { status: "GONE" };
          }
          return isCancelled(current.status) ? { status: "ALREADY_CANCELLED" } : { status: "TOO_LATE", currentStatus: current.status };
        }

        // The draft is not going out. Marking it ends it for the queue as well, so a cancelled reply
        // cannot come back as a review item for someone else to approve.
        await tx.aiDraft.updateMany({
          where: { ...scope, deliveryJob: { operationId } },
          data: { status: "DISMISSED", updatedAt: at },
        });
        await tx.conversation.update({ where: conversationKey(conversationId), data: humanOwnership(context.userId, at) });
        return { status: "SEND_CANCELLED" };
      });
    },
  };
}

function isCancelled(status: string): boolean {
  return status === "CANCELLED_SUPERSEDED" || status === "CANCELLED_HUMAN_TAKEOVER" || status === "CANCELLED_POLICY";
}
