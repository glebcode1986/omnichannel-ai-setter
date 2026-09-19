/**
 * What happens when a person acts on a review item (HUMAN_HANDOFF.md, ADR-004, ADR-014).
 *
 * The rule that shapes every branch: **no action here sends anything.** Approving or editing a draft hands
 * it to the same delivery coordinator that automation uses, with the same final revalidation. A convenience
 * path that sent directly would be a second sending route with none of the gates — and it would be added
 * for the best of reasons, because the human has already decided.
 *
 * Two more, each learned from a specific way this goes wrong:
 *
 * - **the review item is claimed before anything else happens.** Two colleagues opening the same queue is
 *   normal, both clicking send is not, and only the database can decide which click counted.
 * - **an edited reply becomes a style example, never a fact.** What a person wrote tells us how this
 *   business sounds; it does not make the claims inside it true. Promoting human text into the factual
 *   corpus would let one hurried message become evidence for every later answer.
 */
import type { Actor, ReviewMode } from "@omnichannel/domain";

export type ReviewAction =
  /** Send the draft exactly as the model wrote it. */
  | { readonly kind: "APPROVE" }
  /** Send the person's own wording instead. */
  | { readonly kind: "EDIT"; readonly text: string; readonly saveAsStyleExample: boolean }
  /** Nothing goes out; the conversation returns to automation. */
  | { readonly kind: "DISMISS"; readonly note?: string }
  /** The person takes the conversation; automation stays out until they hand it back. */
  | { readonly kind: "CLAIM" };

export interface ReviewCommand {
  readonly scope: { readonly workspaceId: string; readonly businessProfileId: string; readonly conversationId: string };
  readonly draftId: string;
  readonly actor: Actor;
  readonly action: ReviewAction;
  /** Present when the review exists because a provider's human-support exception is the only way to reply. */
  readonly reviewMode: ReviewMode;
}

export type ReviewClaim =
  | { readonly kind: "CLAIMED" }
  /** Someone else got there first; their decision stands and this one is discarded. */
  | { readonly kind: "ALREADY_RESOLVED"; readonly byActor?: Actor }
  | { readonly kind: "GONE" };

export interface ReviewStore {
  /** Atomically marks the item as being resolved by this actor. Only one caller can ever win. */
  claimReview(draftId: string, actor: Actor, at: Date): Promise<ReviewClaim>;
  /** Persists the human's final wording and marks the draft's source as human. */
  recordHumanEdit(draftId: string, text: string, actor: Actor, at: Date): Promise<void>;
  /** Hands the draft to the delivery coordinator. Returns the operation that now owns the send. */
  scheduleDelivery(draftId: string, at: Date): Promise<{ readonly operationId: string }>;
  /** Ends the draft and any pending delivery without sending. */
  dismiss(draftId: string, actor: Actor, at: Date, note?: string): Promise<void>;
  /** Records the new ownership produced by the handoff state machine. */
  setTakeover(conversationId: string, actor: Actor, at: Date, keepOwnership: boolean): Promise<void>;
}

/**
 * Style examples are written through their own port, which cannot reach the factual corpus. The separation
 * is structural rather than a matter of care: there is no call here that could write knowledge.
 */
export interface StyleLearningStore {
  recordEditedDraft(input: {
    readonly workspaceId: string;
    readonly businessProfileId: string;
    readonly inboundContext: string;
    readonly outboundText: string;
    readonly approvedByUserId?: string;
    readonly sourceDraftId: string;
  }): Promise<void>;
}

export interface ReviewLogPort {
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface ReviewDependencies {
  readonly reviews: ReviewStore;
  readonly style: StyleLearningStore;
  readonly log: ReviewLogPort;
  readonly now: () => Date;
  /** The customer message the draft answers, used as the style example's context. */
  readonly inboundContextFor: (draftId: string) => Promise<string | undefined>;
}

export type ReviewOutcome =
  | { readonly status: "SCHEDULED"; readonly operationId: string; readonly edited: boolean }
  | { readonly status: "DISMISSED" }
  | { readonly status: "CLAIMED" }
  | { readonly status: "ALREADY_RESOLVED" }
  | { readonly status: "GONE" }
  | { readonly status: "REJECTED"; readonly reason: string };

export async function resolveReview(dependencies: ReviewDependencies, command: ReviewCommand): Promise<ReviewOutcome> {
  const fields = { draftId: command.draftId, conversationId: command.scope.conversationId, action: command.action.kind };
  const at = dependencies.now();

  if (command.action.kind === "EDIT" && command.action.text.trim() === "") {
    // An empty edit is not an approval of the original; refusing is the only reading that cannot surprise.
    return { status: "REJECTED", reason: "an edited reply cannot be empty" };
  }

  const claim = await dependencies.reviews.claimReview(command.draftId, command.actor, at);
  if (claim.kind === "GONE") {
    return { status: "GONE" };
  }
  if (claim.kind === "ALREADY_RESOLVED") {
    // Two colleagues opened the same queue. The first decision stands; this one changes nothing.
    dependencies.log.info("review.already_resolved", fields);
    return { status: "ALREADY_RESOLVED" };
  }

  if (command.action.kind === "CLAIM") {
    await dependencies.reviews.setTakeover(command.scope.conversationId, command.actor, at, true);
    dependencies.log.info("review.claimed", fields);
    return { status: "CLAIMED" };
  }

  if (command.action.kind === "DISMISS") {
    await dependencies.reviews.dismiss(command.draftId, command.actor, at, command.action.note);
    // Dismissing hands the conversation back: nobody is holding it and nothing is waiting.
    await dependencies.reviews.setTakeover(command.scope.conversationId, command.actor, at, false);
    dependencies.log.info("review.dismissed", fields);
    return { status: "DISMISSED" };
  }

  const edited = command.action.kind === "EDIT";
  if (command.action.kind === "EDIT") {
    await dependencies.reviews.recordHumanEdit(command.draftId, command.action.text, command.actor, at);
    if (command.action.saveAsStyleExample) {
      await learnFromEdit(dependencies, command, command.action.text);
    }
  }

  // The one route out. Whether it is actually sent is still the coordinator's decision, made against live
  // state — including, for a human-support exception, eligibility re-checked immediately before dispatch.
  const { operationId } = await dependencies.reviews.scheduleDelivery(command.draftId, at);
  await dependencies.reviews.setTakeover(command.scope.conversationId, command.actor, at, true);
  dependencies.log.info("review.scheduled", { ...fields, operationId, edited, reviewMode: command.reviewMode });
  return { status: "SCHEDULED", operationId, edited };
}

/**
 * Human wording becomes a style example and nothing else. Failing to learn from an edit must never stop the
 * reply the person actually asked for, so a failure here is logged rather than raised.
 */
async function learnFromEdit(dependencies: ReviewDependencies, command: ReviewCommand, text: string): Promise<void> {
  const inboundContext = await dependencies.inboundContextFor(command.draftId);
  if (inboundContext === undefined) {
    dependencies.log.warn("review.style_context_missing", { draftId: command.draftId });
    return;
  }
  try {
    await dependencies.style.recordEditedDraft({
      workspaceId: command.scope.workspaceId,
      businessProfileId: command.scope.businessProfileId,
      inboundContext,
      outboundText: text,
      ...(command.actor.kind === "USER" ? { approvedByUserId: command.actor.userId } : {}),
      sourceDraftId: command.draftId,
    });
  } catch (error) {
    dependencies.log.warn("review.style_not_recorded", {
      draftId: command.draftId,
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}
