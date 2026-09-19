/**
 * PostgreSQL implementation of the review queue's ports (HUMAN_HANDOFF.md, ADR-004).
 *
 * The claim is the same idea as the delivery coordinator's, for the same reason: two colleagues opening one
 * queue is normal, both acting on the same item is not, and only the database can decide which click
 * counted. A conditional `UPDATE` from `PENDING` to `CLAIMED` can succeed exactly once.
 *
 * Unlike delivery, these operations are taken on behalf of a signed-in member, so every one of them is
 * scoped by an authorized `BusinessProfileContext` rather than by a queue job's own row.
 */
import type { ReviewClaim, ReviewStore, StyleLearningStore } from "@omnichannel/application";
import { randomUUID } from "node:crypto";

import type { DbClient } from "./client";
import { profileScopeOf, type BusinessProfileContext } from "./tenancy";

export function createReviewStore(db: DbClient, context: BusinessProfileContext): ReviewStore {
  const scope = profileScopeOf(context);

  return {
    async claimReview(draftId, actor, at): Promise<ReviewClaim> {
      // One conditional UPDATE: only a draft still waiting for a decision can be claimed, and only once.
      const claimed = await db.aiDraft.updateMany({
        where: { ...scope, id: draftId, status: "PENDING" },
        data: { status: "CLAIMED", updatedAt: at },
      });
      if (claimed.count === 1) {
        void actor;
        return { kind: "CLAIMED" };
      }
      const existing = await db.aiDraft.findUnique({ where: { workspaceId_businessProfileId_id: { ...scope, id: draftId } }, select: { status: true } });
      return existing === null ? { kind: "GONE" } : { kind: "ALREADY_RESOLVED" };
    },

    async recordHumanEdit(draftId, text, actor, at) {
      await db.aiDraft.update({
        where: { workspaceId_businessProfileId_id: { ...scope, id: draftId } },
        // The human's wording replaces the model's, and the draft records who wrote it. The model's own
        // structured output is left untouched: it is evidence about what the model produced, not about
        // what was sent.
        data: { text, updatedAt: at, ...(actor.kind === "USER" ? { requestedByUserId: actor.userId, trigger: "HUMAN_REQUEST" } : {}) },
      });
    },

    async scheduleDelivery(draftId, at) {
      const operationId = randomUUID();
      const draft = await db.aiDraft.findUniqueOrThrow({
        where: { workspaceId_businessProfileId_id: { ...scope, id: draftId } },
        select: { conversationId: true, deliveryJob: { select: { operationId: true } } },
      });
      if (draft.deliveryJob !== null) {
        // One delivery per draft, enforced by a unique index: a second click reuses the first operation
        // rather than creating a second logical send.
        return { operationId: draft.deliveryJob.operationId };
      }
      await db.$transaction(async (tx) => {
        await tx.deliveryJobRecord.create({
          data: {
            ...scope,
            draftId,
            operationId,
            correlationId: operationId,
            status: "SCHEDULED",
            // A human has already decided, so there is no human-like delay left to simulate.
            scheduledFor: at,
            selectedDelayMs: 0,
          },
        });
        await tx.aiDraft.update({ where: { workspaceId_businessProfileId_id: { ...scope, id: draftId } }, data: { status: "SCHEDULED" } });
      });
      return { operationId };
    },

    async dismiss(draftId, _actor, at, note) {
      await db.aiDraft.update({
        where: { workspaceId_businessProfileId_id: { ...scope, id: draftId } },
        data: { status: "DISMISSED", updatedAt: at, ...(note === undefined ? {} : { suggestedAction: note }) },
      });
    },

    async setTakeover(conversationId, actor, at, keepOwnership) {
      await db.conversation.update({
        where: { workspaceId_businessProfileId_id: { ...scope, id: conversationId } },
        data: keepOwnership
          ? {
              takeoverState: "HUMAN_ACTIVE",
              takeoverReason: "HUMAN_SENT_FROM_INBOX",
              takeoverReviewMode: null,
              humanTakeoverAt: at,
              takeoverActorKind: actor.kind,
              ...(actor.kind === "USER" ? { takeoverActorUserId: actor.userId } : { takeoverActorUserId: null }),
              // A fresh human action clears any earlier auto-resume deadline rather than inheriting it.
              takeoverPausedUntil: null,
            }
          : {
              takeoverState: "NONE",
              takeoverReason: null,
              takeoverReviewMode: null,
              humanTakeoverAt: null,
              takeoverPausedUntil: null,
              takeoverActorKind: null,
              takeoverActorUserId: null,
            },
      });
    },
  };
}

/**
 * Writes a style example from a human-edited draft, and can write nothing else.
 *
 * The narrowness is the point: there is no call on this store that could reach `knowledge_documents`, so
 * "human text never becomes a fact" is a property of the type rather than a rule someone has to remember
 * while editing this file later.
 */
export function createStyleLearningStore(db: DbClient, context: BusinessProfileContext): StyleLearningStore {
  const scope = profileScopeOf(context);
  return {
    async recordEditedDraft(input) {
      await db.styleExample.create({
        data: {
          workspaceId: scope.workspaceId,
          businessProfileId: scope.businessProfileId,
          inboundContext: input.inboundContext,
          outboundText: input.outboundText,
          // The provenance the schema admits for a reply a person actually wrote or corrected.
          provenance: "HUMAN_EDITED_DRAFT",
          sourceDraftId: input.sourceDraftId,
          ...(input.approvedByUserId === undefined ? {} : { approvedByUserId: input.approvedByUserId }),
        },
      });
    },
  };
}
