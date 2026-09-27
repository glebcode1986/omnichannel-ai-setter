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
import type { Actor, ReviewMode, SendAuthority, UserId } from "@omnichannel/domain";

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

/**
 * How a decision ended. Every one of these is a *committed* state, not a step towards one.
 *
 * `FOREIGN_CONVERSATION` is a refusal, not a race: the draft belongs to a different conversation than the
 * command names, so approving it would take ownership of one conversation while sending into another, and
 * the authority and the recipient would describe two different actions.
 */
export type ReviewDecision =
  | { readonly kind: "SCHEDULED"; readonly operationId: string }
  | { readonly kind: "DISMISSED" }
  | { readonly kind: "CLAIMED" }
  /** Someone else got there first; their decision stands and this one changes nothing. */
  | { readonly kind: "ALREADY_RESOLVED"; readonly byActor?: Actor }
  | { readonly kind: "GONE" }
  | { readonly kind: "FOREIGN_CONVERSATION" };

export interface ReviewStore {
  /**
   * The whole approval, in one transaction: win the item, persist the final wording, record the authority,
   * create the delivery, mark the draft scheduled, and take the conversation for the approver.
   *
   * One transaction because every one of those is part of the same decision. Claimed separately, a crash or
   * a thrown dependency anywhere in between left a draft permanently `CLAIMED` with no delivery — a review
   * item nobody could act on again, because the retry is told somebody already resolved it.
   *
   * Idempotent on purpose: a retry (or a second click) that finds the delivery already created returns the
   * same operation rather than a refusal, so reporting a decision and committing it cannot disagree.
   */
  resolveApproval(input: {
    readonly draftId: string;
    readonly conversationId: string;
    readonly authority: SendAuthority;
    /** The person's own wording, when they changed it. Written in the same transaction as everything else. */
    readonly editedText?: string;
    readonly at: Date;
  }): Promise<ReviewDecision>;
  /** Ends the draft without sending and hands the conversation back, in one transaction. */
  resolveDismissal(input: {
    readonly draftId: string;
    readonly conversationId: string;
    readonly actor: Actor;
    readonly at: Date;
    readonly note?: string;
  }): Promise<ReviewDecision>;
  /** Takes the conversation for this person without sending anything, in one transaction. */
  resolveClaim(input: {
    readonly draftId: string;
    readonly conversationId: string;
    readonly actor: Actor;
    readonly at: Date;
  }): Promise<ReviewDecision>;
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

  const target = { draftId: command.draftId, conversationId: command.scope.conversationId, at };

  if (command.action.kind === "CLAIM") {
    return outcomeOf(dependencies, fields, await dependencies.reviews.resolveClaim({ ...target, actor: command.actor }));
  }

  if (command.action.kind === "DISMISS") {
    const note = command.action.note;
    return outcomeOf(
      dependencies,
      fields,
      await dependencies.reviews.resolveDismissal({ ...target, actor: command.actor, ...(note === undefined ? {} : { note }) }),
    );
  }

  // Sending is the one decision only a person can make. A `SYSTEM` or `NATIVE_APP` actor is human activity
  // for the purpose of takeover — a message sent from the Instagram app is a person acting — but neither can
  // look at a draft and decide it may go out, and the authority to send is what approving grants. Refused
  // here, before anything is claimed, so a rejected command leaves no trace on the queue.
  const approver = approvingUser(command.actor);
  if (approver === undefined) {
    dependencies.log.warn("review.actor_cannot_approve", { ...fields, actorKind: command.actor.kind });
    return { status: "REJECTED", reason: "only a signed-in person can approve or edit a reply" };
  }

  // The one route out. Whether it is actually sent is still the coordinator's decision, made against live
  // state — including, for a human-support exception, eligibility re-checked immediately before dispatch.
  //
  // What travels with it is the authority: who approved this, when, and which send they authorized. It is
  // persisted with the delivery rather than passed along in memory, because the send happens later, in
  // another process, and an approval that only existed in this call would arrive there as automation.
  const authority: SendAuthority = {
    kind: "HUMAN_APPROVED",
    approvedByUserId: approver,
    approvedAt: at,
    reviewMode: command.reviewMode,
  };
  const edited = command.action.kind === "EDIT";
  const decision = await dependencies.reviews.resolveApproval({
    ...target,
    authority,
    ...(command.action.kind === "EDIT" ? { editedText: command.action.text } : {}),
  });

  if (decision.kind !== "SCHEDULED") {
    return outcomeOf(dependencies, fields, decision);
  }
  // After the commit, and never before it: what a person wrote is worth learning from, and it is worth
  // less than the reply they asked for. A style store that is down must not be able to lose the send.
  if (command.action.kind === "EDIT" && command.action.saveAsStyleExample) {
    await learnFromEdit(dependencies, command, command.action.text);
  }
  dependencies.log.info("review.scheduled", { ...fields, operationId: decision.operationId, edited, reviewMode: command.reviewMode });
  return { status: "SCHEDULED", operationId: decision.operationId, edited };
}

/** Only a signed-in person can grant the authority to send; everything else is refused by the type. */
function approvingUser(actor: Actor): UserId | undefined {
  return actor.kind === "USER" ? actor.userId : undefined;
}

/** The committed decision, in the vocabulary the caller uses, with the one line of audit it deserves. */
function outcomeOf(dependencies: ReviewDependencies, fields: Readonly<Record<string, unknown>>, decision: ReviewDecision): ReviewOutcome {
  switch (decision.kind) {
    case "GONE":
      return { status: "GONE" };
    case "FOREIGN_CONVERSATION":
      // The draft and the conversation named do not belong together, so no single action was described.
      dependencies.log.warn("review.foreign_conversation", fields);
      return { status: "REJECTED", reason: "the draft belongs to a different conversation" };
    case "ALREADY_RESOLVED":
      // Two colleagues opened the same queue. The first decision stands; this one changes nothing.
      dependencies.log.info("review.already_resolved", fields);
      return { status: "ALREADY_RESOLVED" };
    case "CLAIMED":
      dependencies.log.info("review.claimed", fields);
      return { status: "CLAIMED" };
    case "DISMISSED":
      dependencies.log.info("review.dismissed", fields);
      return { status: "DISMISSED" };
    case "SCHEDULED":
      return { status: "SCHEDULED", operationId: decision.operationId, edited: false };
  }
}

/**
 * Human wording becomes a style example and nothing else. Failing to learn from an edit must never stop the
 * reply the person actually asked for, so a failure here is logged rather than raised.
 */
async function learnFromEdit(dependencies: ReviewDependencies, command: ReviewCommand, text: string): Promise<void> {
  try {
    const inboundContext = await dependencies.inboundContextFor(command.draftId);
    if (inboundContext === undefined) {
      dependencies.log.warn("review.style_context_missing", { draftId: command.draftId });
      return;
    }
    await dependencies.style.recordEditedDraft({
      workspaceId: command.scope.workspaceId,
      businessProfileId: command.scope.businessProfileId,
      inboundContext,
      outboundText: text,
      ...(command.actor.kind === "USER" ? { approvedByUserId: command.actor.userId } : {}),
      sourceDraftId: command.draftId,
    });
  } catch (error) {
    // Everything, including looking up the context. This runs after the decision has committed, so a
    // failure that escaped here would report an error for a reply that is already on its way out.
    dependencies.log.warn("review.style_not_recorded", {
      draftId: command.draftId,
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}
