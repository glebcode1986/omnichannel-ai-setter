/**
 * What a person can do to a conversation besides deciding a review item (HUMAN_HANDOFF.md, ADR-004, #29).
 *
 * Three operations, shaped by the rule that shapes `resolveReview`: **none of them sends anything, and
 * none of them decides anything the server would not decide again.** They move ownership and
 * they stop a send that has not happened yet. Every gate that guards an actual send still runs in the
 * delivery coordinator, immediately before the transport call.
 *
 * - **Take over** — the person owns the conversation and automation stays out until they hand it back.
 * - **Hand back** — automation may act again. Explicit, because the spec says resume is explicit and a
 *   timed auto-resume is an optional extra that must never fire over newer human activity.
 * - **Cancel a pending send** — a reply is queued behind its delay and the person does not want it sent.
 *
 * Cancelling is *also* a takeover, and not as a convenience: HUMAN_HANDOFF.md lists "human explicitly
 * claims/pauses a conversation" as a takeover trigger, and someone stopping a queued reply is asserting
 * exactly that. Leaving automation running after they stopped its message would let the next draft go out
 * seconds later, which is the outcome they just refused.
 */
export type ConversationOperation =
  /** The person takes the conversation; automation stays out. */
  | { readonly kind: "TAKE_OVER" }
  /**
   * Automation may act again.
   *
   * `pauseUntil` is how long automation stays out *before* resuming when the caller wants a timed hold
   * rather than an immediate hand-back; absent means hand back now.
   */
  | { readonly kind: "HAND_BACK"; readonly pauseUntil?: Date }
  /** Stop a queued send that has not been claimed by the worker yet. */
  | { readonly kind: "CANCEL_SEND"; readonly operationId: string };

export interface ConversationOperationCommand {
  readonly scope: { readonly workspaceId: string; readonly businessProfileId: string; readonly conversationId: string };
  readonly operation: ConversationOperation;
}

/**
 * How an operation ended. Every one of these is a committed state, not a step towards one.
 *
 * `TOO_LATE` is the answer that matters. A send already claimed by a worker may be mid-flight at the
 * provider, and ADR-012 forbids guessing about a send whose outcome is unknown — so it is not cancelled,
 * and the caller is told plainly rather than shown a success that would be a lie about what the customer
 * received.
 */
export type ConversationOperationOutcome =
  | { readonly status: "TAKEN_OVER" }
  | { readonly status: "HANDED_BACK" }
  | { readonly status: "SEND_CANCELLED" }
  /** The send was already cancelled, by this person or by the engine. Nothing changed and nothing is wrong. */
  | { readonly status: "ALREADY_CANCELLED" }
  /** The worker already has it. Nothing was cancelled, and the caller must not report otherwise. */
  | { readonly status: "TOO_LATE"; readonly currentStatus: string }
  | { readonly status: "GONE" }
  | { readonly status: "REJECTED"; readonly reason: string };

export interface ConversationOperationStore {
  /** Takes the conversation for the authenticated person. Idempotent: taking it twice is taking it. */
  takeOver(input: { readonly conversationId: string; readonly at: Date }): Promise<ConversationOperationOutcome>;
  /** Hands it back to automation, optionally after a pause. */
  handBack(input: { readonly conversationId: string; readonly at: Date; readonly pauseUntil?: Date }): Promise<ConversationOperationOutcome>;
  /**
   * Cancels a scheduled send and takes the conversation, in one transaction.
   *
   * Conditional on the delivery still being `SCHEDULED`. A job the worker has claimed is refused rather
   * than raced: only the database can decide which of the two got there first.
   */
  cancelSend(input: {
    readonly conversationId: string;
    readonly operationId: string;
    readonly at: Date;
  }): Promise<ConversationOperationOutcome>;
}

export interface ConversationOperationLogPort {
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface ConversationOperationDependencies {
  readonly conversations: ConversationOperationStore;
  readonly log: ConversationOperationLogPort;
  readonly now: () => Date;
}

export async function operateConversation(
  dependencies: ConversationOperationDependencies,
  command: ConversationOperationCommand,
): Promise<ConversationOperationOutcome> {
  const at = dependencies.now();
  const fields = { conversationId: command.scope.conversationId, operation: command.operation.kind };

  const outcome = await run(dependencies, command, at);

  if (outcome.status === "REJECTED" || outcome.status === "TOO_LATE" || outcome.status === "GONE") {
    dependencies.log.warn("conversation.operation_refused", { ...fields, status: outcome.status });
  } else {
    dependencies.log.info("conversation.operation", { ...fields, status: outcome.status });
  }
  return outcome;
}

async function run(
  dependencies: ConversationOperationDependencies,
  command: ConversationOperationCommand,
  at: Date,
): Promise<ConversationOperationOutcome> {
  const { conversationId } = command.scope;
  switch (command.operation.kind) {
    case "TAKE_OVER":
      return dependencies.conversations.takeOver({ conversationId, at });
    case "HAND_BACK": {
      const { pauseUntil } = command.operation;
      if (pauseUntil !== undefined && pauseUntil.getTime() <= at.getTime()) {
        // A pause that has already expired is not a pause; accepting it would write a deadline the next
        // read treats as "resume immediately", which is a different operation than the one asked for.
        return { status: "REJECTED", reason: "a pause must end in the future" };
      }
      return dependencies.conversations.handBack({ conversationId, at, ...(pauseUntil === undefined ? {} : { pauseUntil }) });
    }
    case "CANCEL_SEND":
      return dependencies.conversations.cancelSend({ conversationId, operationId: command.operation.operationId, at });
  }
}
