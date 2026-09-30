"use server";

/**
 * Server actions for review decisions and conversation control (HUMAN_HANDOFF.md, Issue #29).
 *
 * Three rules this file exists to hold.
 *
 * **Authorization is re-resolved here, from the database, on every call.** Not from the form, not from a
 * hidden field, not from whatever the component believed when it rendered. A disabled button is a courtesy
 * to the person using the page; the boundary is this file. Because an AGENT's access is granted per
 * Business Profile, `requireBusinessProfileContext` *is* the role check — someone granted one profile
 * cannot decide a review item in another, whatever id the form carried.
 *
 * **Nothing here sends anything.** Approving and editing hand the wording to the same delivery coordinator
 * automation uses, with the same final revalidation immediately before the transport call. A convenience
 * path that sent directly would be a second sending route with none of the gates, and it would be added
 * for the best of reasons — the person has already decided.
 *
 * **The outcome travels in the URL, not in client state.** Every action redirects back with what happened,
 * so a stale decision, a send that was already claimed and an ordinary success are all things the next
 * render can explain. It also means the refusals survive a reload, which is when someone reads them.
 */
import {
  composeHumanReply,
  createConversationOperationStore,
  createReviewStore,
  createStyleLearningStore,
  type BusinessProfileContext,
} from "@omnichannel/db";
import { operateConversation, resolveReview, type ReviewAction } from "@omnichannel/application";
import type { ReviewMode } from "@omnichannel/domain";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { getDb } from "./db";
import { getLogger } from "./logger";
import { requireBusinessProfileContext } from "./request-context";

export interface ConversationTarget {
  readonly workspaceId: string;
  readonly businessProfileId: string;
  readonly conversationId: string;
}

/** What the next render tells the person. Every value is a state the server actually reached. */
export type ActionOutcome =
  | "SENT"
  | "DISMISSED"
  | "CLAIMED"
  | "TAKEN_OVER"
  | "HANDED_BACK"
  | "SEND_CANCELLED"
  | "ALREADY_CANCELLED"
  | "ALREADY_RESOLVED"
  | "TOO_LATE"
  | "STALE"
  | "GONE"
  | "REJECTED"
  | "COMPOSED"
  | "COMPOSE_REPLAYED"
  | "ALREADY_PENDING"
  | "NOT_OPEN";

const inboxPath = (target: ConversationTarget) =>
  `/workspaces/${target.workspaceId}/profiles/${target.businessProfileId}/inbox/${target.conversationId}`;
const reviewPath = (target: { readonly workspaceId: string; readonly businessProfileId: string }) =>
  `/workspaces/${target.workspaceId}/profiles/${target.businessProfileId}/review`;

/** A `FormData` entry can be a `File`; anything that is not a string is simply not a value. */
function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function dependenciesFor(context: BusinessProfileContext) {
  return {
    reviews: createReviewStore(getDb(), context),
    style: createStyleLearningStore(getDb(), context),
    log: getLogger(),
    now: () => new Date(),
    /**
     * The customer message a draft answers, used as a style example's context.
     *
     * Read from the draft's own anchor rather than from "the latest inbound", which would attach a
     * person's wording to a message it was never a reply to the moment a conversation moved on.
     */
    inboundContextFor: async (draftId: string): Promise<string | undefined> => {
      const draft = await getDb().aiDraft.findFirst({
        where: { workspaceId: context.workspaceId, businessProfileId: context.businessProfileId, id: draftId },
        select: { anchorMessage: { select: { text: true } } },
      });
      return draft?.anchorMessage.text ?? undefined;
    },
  };
}

async function decide(target: ConversationTarget, draftId: string, action: ReviewAction, reviewMode: ReviewMode): Promise<ActionOutcome> {
  const context = await requireBusinessProfileContext(target.workspaceId, target.businessProfileId);

  // Staleness is not checked here. A send on a draft the customer has overtaken is refused by the store,
  // inside the transaction that would otherwise create the delivery — so no caller can skip it and no
  // inbound message can arrive between the check and the commit. This layer only renders the answer.
  const outcome = await resolveReview(dependenciesFor(context), {
    scope: { workspaceId: target.workspaceId, businessProfileId: target.businessProfileId, conversationId: target.conversationId },
    draftId,
    action,
    reviewMode,
  });

  switch (outcome.status) {
    case "SCHEDULED":
      return "SENT";
    case "DISMISSED":
      return "DISMISSED";
    case "CLAIMED":
      return "CLAIMED";
    case "ALREADY_RESOLVED":
      return "ALREADY_RESOLVED";
    case "GONE":
      return "GONE";
    case "STALE":
      return "STALE";
    case "REJECTED":
      return "REJECTED";
  }
}

/** `HUMAN_AGENT` only when the form says so, because it authorizes a different transport (ADR-014). */
function reviewModeOf(formData: FormData): ReviewMode {
  return field(formData, "reviewMode") === "HUMAN_AGENT" ? "HUMAN_AGENT" : "NORMAL";
}

/** Where the person was when they acted, so a decision returns them to the list or the conversation. */
function returnPath(target: ConversationTarget, formData: FormData): string {
  return field(formData, "from") === "review" ? reviewPath(target) : inboxPath(target);
}

function finish(path: string, outcome: ActionOutcome): never {
  revalidatePath(path);
  redirect(`${path}?outcome=${outcome}`);
}

export async function approveDraftAction(target: ConversationTarget, formData: FormData): Promise<void> {
  const outcome = await decide(target, field(formData, "draftId"), { kind: "APPROVE" }, reviewModeOf(formData));
  finish(returnPath(target, formData), outcome);
}

export async function editAndSendAction(target: ConversationTarget, formData: FormData): Promise<void> {
  const outcome = await decide(
    target,
    field(formData, "draftId"),
    { kind: "EDIT", text: field(formData, "text"), saveAsStyleExample: field(formData, "learn") === "on" },
    reviewModeOf(formData),
  );
  finish(returnPath(target, formData), outcome);
}

export async function dismissDraftAction(target: ConversationTarget, formData: FormData): Promise<void> {
  const note = field(formData, "note");
  const outcome = await decide(target, field(formData, "draftId"), { kind: "DISMISS", ...(note === "" ? {} : { note }) }, reviewModeOf(formData));
  finish(returnPath(target, formData), outcome);
}

export async function claimDraftAction(target: ConversationTarget, formData: FormData): Promise<void> {
  const outcome = await decide(target, field(formData, "draftId"), { kind: "CLAIM" }, reviewModeOf(formData));
  finish(returnPath(target, formData), outcome);
}

async function operate(
  target: ConversationTarget,
  operation: Parameters<typeof operateConversation>[1]["operation"],
): Promise<ActionOutcome> {
  const context = await requireBusinessProfileContext(target.workspaceId, target.businessProfileId);
  const outcome = await operateConversation(
    { conversations: createConversationOperationStore(getDb(), context), log: getLogger(), now: () => new Date() },
    {
      scope: { workspaceId: target.workspaceId, businessProfileId: target.businessProfileId, conversationId: target.conversationId },
      operation,
    },
  );
  switch (outcome.status) {
    case "TAKEN_OVER":
      return "TAKEN_OVER";
    case "HANDED_BACK":
      return "HANDED_BACK";
    case "SEND_CANCELLED":
      return "SEND_CANCELLED";
    case "ALREADY_CANCELLED":
      return "ALREADY_CANCELLED";
    case "TOO_LATE":
      return "TOO_LATE";
    case "GONE":
      return "GONE";
    case "REJECTED":
      return "REJECTED";
  }
}

export async function takeOverAction(target: ConversationTarget, formData: FormData): Promise<void> {
  finish(returnPath(target, formData), await operate(target, { kind: "TAKE_OVER" }));
}

export async function handBackAction(target: ConversationTarget, formData: FormData): Promise<void> {
  const hours = Number.parseInt(field(formData, "pauseHours"), 10);
  // A pause is optional. An unparseable or non-positive value is "hand it back now" rather than a
  // silently different operation.
  const pauseUntil = Number.isFinite(hours) && hours > 0 ? new Date(Date.now() + hours * 3_600_000) : undefined;
  finish(returnPath(target, formData), await operate(target, { kind: "HAND_BACK", ...(pauseUntil === undefined ? {} : { pauseUntil }) }));
}

export async function cancelSendAction(target: ConversationTarget, formData: FormData): Promise<void> {
  finish(returnPath(target, formData), await operate(target, { kind: "CANCEL_SEND", operationId: field(formData, "operationId") }));
}

/**
 * A person's own reply, handed to the same coordinator (ADR-018 Option B, accepted 2026-09-30).
 *
 * This action creates a delivery and nothing else. It does not send: the worker claims the row, re-reads
 * every fact, and runs the policy engine, the takeover check, the window check, the account-health check
 * and the kill switch immediately before the transport call. A composer that sent directly would be a
 * second send path with none of those gates, which the contract forbids.
 *
 * No AI draft is created. A person's words are not a generation, and writing them into `ai_drafts` would
 * put invented model metadata into every metric that counts drafts.
 */
export async function composeReplyAction(target: ConversationTarget, formData: FormData): Promise<void> {
  const context = await requireBusinessProfileContext(target.workspaceId, target.businessProfileId);
  const outcome = await composeHumanReply(getDb(), context, {
    conversationId: target.conversationId,
    text: field(formData, "text"),
    // `HUMAN_AGENT` only when the form said so: it authorizes a different transport (ADR-014).
    reviewMode: field(formData, "reviewMode") === "HUMAN_AGENT" ? "HUMAN_AGENT" : "NORMAL",
  });

  finish(
    returnPath(target, formData),
    outcome.status === "SCHEDULED"
      ? outcome.replayed
        ? "COMPOSE_REPLAYED"
        : "COMPOSED"
      : outcome.status === "ALREADY_PENDING"
        ? "ALREADY_PENDING"
        : outcome.status === "GONE"
          ? "GONE"
          : outcome.reason === "this conversation is not open"
            ? "NOT_OPEN"
            : "REJECTED",
  );
}
