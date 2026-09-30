/**
 * A person's own reply, handed to the same delivery coordinator automation uses (ADR-018 Option B, #29).
 *
 * The decision this implements: a human-composed reply gets an honest non-AI origin on the delivery
 * record. It does **not** become an `AiDraft` — that table records what a model produced, and inventing
 * `confidence`, `model_provider`, `prompt_version` and the rest for text a person typed would put
 * imaginary generations into `readReliabilitySnapshot`, `countUnusableGenerations` and the evals.
 *
 * What this file creates is a `SCHEDULED` delivery and nothing else. It does not send, does not skip a
 * gate, and does not reach a transport: the worker claims the row, re-reads every fact, runs the policy
 * engine, the kill switch, the takeover check, the window check and the account health check, and only
 * then calls the provider. There is one send path and this is not a second one — it is the same one,
 * entered with a different origin.
 *
 * Idempotency is the decision's own digest, exactly as `resolveApproval` does it: a second submit of the
 * same wording by the same person is answered with the delivery the first one created, and a *different*
 * message while one is still pending is refused rather than queued behind it.
 */
import { createHash, randomUUID } from "node:crypto";

import type { DbClient, DbExecutor } from "./client";
import { recordAuditEvent } from "./audit-store";
import { profileScopeOf, type BusinessProfileContext } from "./tenancy";

export type ComposeOutcome =
  | { readonly status: "SCHEDULED"; readonly operationId: string; readonly replayed: boolean }
  /** Another reply of this person's is already queued for this conversation and has not gone out. */
  | { readonly status: "ALREADY_PENDING"; readonly operationId: string }
  | { readonly status: "GONE" }
  | { readonly status: "REFUSED"; readonly reason: string };

export interface ComposeInput {
  readonly conversationId: string;
  readonly text: string;
  /** Which send is being authorized: an ordinary reply, or the provider's human-support path (ADR-014). */
  readonly reviewMode: "NORMAL" | "HUMAN_AGENT";
  readonly at?: Date;
}

/**
 * Queues a person's reply for the coordinator to send.
 *
 * No delay: a human has already decided, so there is no human-like pause left to simulate. The
 * coordinator still revalidates immediately before the transport call, which is where a takeover, a newer
 * inbound message, a closed window, a suspended account or a changed policy stops it.
 */
export async function composeHumanReply(db: DbClient, context: BusinessProfileContext, input: ComposeInput): Promise<ComposeOutcome> {
  const scope = profileScopeOf(context);
  const at = input.at ?? new Date();
  const text = input.text.trim();
  if (text === "") {
    // An empty reply is not a reply. The CHECK would refuse it too; this refuses it with a sentence.
    return { status: "REFUSED", reason: "a reply cannot be empty" };
  }
  const decisionKey = composeKey(context.userId, input.conversationId, text, input.reviewMode);

  return db.$transaction(async (tx) => {
    const conversation = await tx.conversation.findFirst({
      where: { ...scope, id: input.conversationId },
      select: { id: true, status: true },
    });
    if (conversation === null) {
      return { status: "GONE" };
    }
    if (conversation.status !== "OPEN") {
      // A closed or archived conversation is not one to reply into. The coordinator would refuse it at
      // send time anyway; saying so now is the difference between a refusal and a reply that vanishes.
      return { status: "REFUSED", reason: "this conversation is not open" };
    }

    const pending = await tx.deliveryJobRecord.findFirst({
      where: {
        ...scope,
        conversationId: input.conversationId,
        humanText: { not: null },
        status: { in: ["SCHEDULED", "SENDING"] },
      },
      select: { operationId: true, decisionKey: true },
    });
    if (pending !== null) {
      // The same wording twice is one decision reported twice — a double click, or a retry after a lost
      // response. Answered with the send that already exists.
      return pending.decisionKey === decisionKey
        ? { status: "SCHEDULED", operationId: pending.operationId, replayed: true }
        : // Different wording while one is still queued is two messages, not idempotency. Refused, and
          // the caller is told which send is in the way so a person can cancel it and try again.
          { status: "ALREADY_PENDING", operationId: pending.operationId };
    }

    const operationId = randomUUID();
    await tx.deliveryJobRecord.create({
      data: {
        ...scope,
        // No draft: the origin is the person's own wording, which the CHECK pairs with their name.
        humanText: text,
        composedByUserId: context.userId,
        conversationId: input.conversationId,
        operationId,
        correlationId: operationId,
        status: "SCHEDULED",
        scheduledFor: at,
        selectedDelayMs: 0,
        // Persisted with the delivery because the send happens later, in another process: an approval
        // that lived only in this request would arrive there as automation (ADR-014).
        authority: "HUMAN_APPROVED",
        approvedByUserId: context.userId,
        approvedAt: at,
        approvedReviewMode: input.reviewMode,
        decisionKey,
      },
    });
    // Replying is taking the conversation: the person who just spoke for the business owns it.
    await tx.conversation.update({
      where: { workspaceId_businessProfileId_id: { ...scope, id: input.conversationId } },
      data: {
        takeoverState: "HUMAN_ACTIVE",
        takeoverReason: "HUMAN_SENT_FROM_INBOX",
        takeoverReviewMode: null,
        humanTakeoverAt: at,
        takeoverActorKind: "USER",
        takeoverActorUserId: context.userId,
        takeoverPausedUntil: null,
      },
    });
    // A person's own words going out is a material action, and one that a reader of the thread cannot
    // distinguish from an approved draft without this.
    await recordAuditEvent(tx, context, {
      kind: "REPLY_COMPOSED",
      summary: "Composed and sent a reply",
      subjectType: "delivery_jobs",
      subjectId: operationId,
      actorUserId: context.userId,
      conversationId: input.conversationId,
      detail: { reviewMode: input.reviewMode },
      occurredAt: at,
    });
    return { status: "SCHEDULED", operationId, replayed: false };
  });
}

/**
 * The identity of one composing decision.
 *
 * Who, where, the exact wording and which send they authorized. A digest rather than the text itself so
 * the column stays a fixed size, and salted with nothing: it identifies a decision, it does not protect
 * one.
 */
function composeKey(userId: string, conversationId: string, text: string, reviewMode: string): string {
  return createHash("sha256").update([userId, conversationId, reviewMode, text].join("\u0000")).digest("hex");
}

/** Whether this conversation already has a person's reply waiting to go out. */
export async function pendingHumanReply(
  db: DbExecutor,
  context: BusinessProfileContext,
  conversationId: string,
): Promise<{ readonly operationId: string; readonly text: string } | undefined> {
  const scope = profileScopeOf(context);
  const pending = await db.deliveryJobRecord.findFirst({
    where: { ...scope, conversationId, humanText: { not: null }, status: { in: ["SCHEDULED", "SENDING"] } },
    select: { operationId: true, humanText: true },
  });
  return pending === null || pending.humanText === null ? undefined : { operationId: pending.operationId, text: pending.humanText };
}
