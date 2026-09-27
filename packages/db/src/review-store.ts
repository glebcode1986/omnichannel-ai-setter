/**
 * PostgreSQL implementation of the review queue's ports (HUMAN_HANDOFF.md, ADR-004).
 *
 * Each of the three decisions a person can make is one transaction, and each begins with the same
 * conditional `UPDATE` from `PENDING`: two colleagues opening one queue is normal, both acting on the same
 * item is not, and only the database can decide which click counted.
 *
 * The transaction holds the *whole* decision, not the claim alone. Claiming separately left a window in
 * which a crash or a failed dependency stranded a draft as `CLAIMED` with nothing done — a review item
 * nobody could act on again, because the retry is told somebody already resolved it. So the claim, the
 * person's final wording, the authority they granted, the delivery, the draft's new status and the
 * conversation's ownership commit together or not at all.
 *
 * Every decision also checks that the draft and the conversation named belong together. Without it, a
 * malformed or hostile command could approve a draft from one conversation while taking ownership of
 * another in the same Business Profile: the delivery path derives the recipient from the draft, so the
 * authority and the reply would describe two different actions.
 *
 * Unlike delivery, these operations are taken on behalf of a signed-in member, so every one of them is
 * scoped by an authorized `BusinessProfileContext` rather than by a queue job's own row.
 */
import type { ReviewDecision, ReviewStore, StyleLearningStore } from "@omnichannel/application";
import { randomUUID } from "node:crypto";

import type { Actor, SendAuthority } from "@omnichannel/domain";

import type { DbClient, DbExecutor } from "./client";
import { profileScopeOf, type BusinessProfileContext } from "./tenancy";

export function createReviewStore(db: DbClient, context: BusinessProfileContext): ReviewStore {
  const scope = profileScopeOf(context);
  const draftKey = (draftId: string) => ({ workspaceId_businessProfileId_id: { ...scope, id: draftId } });
  const conversationKey = (conversationId: string) => ({ workspaceId_businessProfileId_id: { ...scope, id: conversationId } });

  /**
   * The draft this decision is about, and whether the command describes a single coherent action.
   *
   * Returns the refusal rather than throwing, because "somebody else got there first" and "these two rows
   * do not belong together" are both ordinary answers a caller has to render.
   */
  const openDecision = async (
    tx: DbExecutor,
    input: { readonly draftId: string; readonly conversationId: string },
  ): Promise<{ readonly refusal: ReviewDecision } | { readonly operationId: string | undefined }> => {
    const draft = await tx.aiDraft.findUnique({
      where: draftKey(input.draftId),
      select: { conversationId: true, deliveryJob: { select: { operationId: true } } },
    });
    if (draft === null) {
      return { refusal: { kind: "GONE" } };
    }
    if (draft.conversationId !== input.conversationId) {
      return { refusal: { kind: "FOREIGN_CONVERSATION" } };
    }
    return { operationId: draft.deliveryJob?.operationId };
  };

  /** One conditional UPDATE: only a draft still waiting for a decision can be claimed, and only once. */
  const winClaim = async (tx: DbExecutor, draftId: string, at: Date): Promise<boolean> => {
    const claimed = await tx.aiDraft.updateMany({ where: { ...scope, id: draftId, status: "PENDING" }, data: { status: "CLAIMED", updatedAt: at } });
    return claimed.count === 1;
  };

  return {
    async resolveApproval({ draftId, conversationId, authority, editedText, at }) {
      return db.$transaction(async (tx) => {
        const opened = await openDecision(tx, { draftId, conversationId });
        if ("refusal" in opened) {
          return opened.refusal;
        }
        if (opened.operationId !== undefined) {
          // One delivery per draft, enforced by a unique index. A second click — or a retry of a decision
          // that already committed — is the same logical send, so it is told so rather than refused.
          return { kind: "SCHEDULED", operationId: opened.operationId };
        }
        if (!(await winClaim(tx, draftId, at))) {
          return { kind: "ALREADY_RESOLVED" };
        }

        if (editedText !== undefined) {
          // The human's wording replaces the model's, and the draft records who wrote it. The model's own
          // structured output is left untouched: it is evidence about what the model produced, not about
          // what was sent.
          await tx.aiDraft.update({
            where: draftKey(draftId),
            data: { text: editedText, updatedAt: at, requestedByUserId: approverOf(authority), trigger: "HUMAN_REQUEST" },
          });
        }

        const operationId = randomUUID();
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
            ...authorityFieldsFor(authority),
          },
        });
        await tx.aiDraft.update({ where: draftKey(draftId), data: { status: "SCHEDULED" } });
        // Approving a reply is taking the conversation: the person who just spoke for the business owns it.
        await tx.conversation.update({ where: conversationKey(conversationId), data: ownershipFor(authority, at) });
        return { kind: "SCHEDULED", operationId };
      });
    },

    async resolveDismissal({ draftId, conversationId, actor, at, note }) {
      return db.$transaction(async (tx) => {
        const opened = await openDecision(tx, { draftId, conversationId });
        if ("refusal" in opened) {
          return opened.refusal;
        }
        if (!(await winClaim(tx, draftId, at))) {
          return { kind: "ALREADY_RESOLVED" };
        }
        await tx.aiDraft.update({
          where: draftKey(draftId),
          data: { status: "DISMISSED", updatedAt: at, ...(note === undefined ? {} : { suggestedAction: note }) },
        });
        // Dismissing hands the conversation back: nobody is holding it and nothing is waiting.
        await tx.conversation.update({ where: conversationKey(conversationId), data: NO_OWNERSHIP });
        void actor;
        return { kind: "DISMISSED" };
      });
    },

    async resolveClaim({ draftId, conversationId, actor, at }) {
      return db.$transaction(async (tx) => {
        const opened = await openDecision(tx, { draftId, conversationId });
        if ("refusal" in opened) {
          return opened.refusal;
        }
        if (!(await winClaim(tx, draftId, at))) {
          return { kind: "ALREADY_RESOLVED" };
        }
        await tx.conversation.update({ where: conversationKey(conversationId), data: humanOwnership(actor, at) });
        return { kind: "CLAIMED" };
      });
    },
  };
}

/** The conversation belongs to this person from now on, with any earlier auto-resume deadline cleared. */
function humanOwnership(actor: Actor, at: Date) {
  return {
    takeoverState: "HUMAN_ACTIVE",
    takeoverReason: "HUMAN_SENT_FROM_INBOX",
    takeoverReviewMode: null,
    humanTakeoverAt: at,
    takeoverActorKind: actor.kind,
    ...(actor.kind === "USER" ? { takeoverActorUserId: actor.userId } : { takeoverActorUserId: null }),
    // A fresh human action clears any earlier auto-resume deadline rather than inheriting it.
    takeoverPausedUntil: null,
  } as const;
}

/** Nobody is holding the conversation and nothing is waiting on it. */
const NO_OWNERSHIP = {
  takeoverState: "NONE",
  takeoverReason: null,
  takeoverReviewMode: null,
  humanTakeoverAt: null,
  takeoverPausedUntil: null,
  takeoverActorKind: null,
  takeoverActorUserId: null,
} as const;

/** Who owns the conversation once this authority has acted on it. */
function ownershipFor(authority: SendAuthority, at: Date) {
  return authority.kind === "HUMAN_APPROVED"
    ? humanOwnership({ kind: "USER", userId: authority.approvedByUserId }, at)
    : humanOwnership({ kind: "SYSTEM" }, at);
}

/** The person an approval names, for the audit trail on the draft they edited. */
function approverOf(authority: SendAuthority): string | undefined {
  return authority.kind === "HUMAN_APPROVED" ? authority.approvedByUserId : undefined;
}

/**
 * The approval, written out in full or not at all.
 *
 * The table's own CHECK constraint says the same thing, which is deliberate: an authority half-recorded
 * here would be one the send path has to guess at, and a guess is how an automated send acquires a
 * person's name.
 */
function authorityFieldsFor(authority: SendAuthority) {
  if (authority.kind !== "HUMAN_APPROVED") {
    return { authority: "AUTOMATED" } as const;
  }
  return {
    authority: "HUMAN_APPROVED",
    approvedByUserId: authority.approvedByUserId,
    approvedAt: authority.approvedAt,
    approvedReviewMode: authority.reviewMode,
  } as const;
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
