import { literalGuard } from "./enum";
import type { UserId } from "./ids";

/** Why a human owns or must review the conversation (HUMAN_HANDOFF.md). */
export const TAKEOVER_REASONS = [
  "HUMAN_SENT_FROM_INBOX",
  "UNMATCHED_OUTBOUND_ECHO",
  "HUMAN_CLAIMED",
  "MANDATORY_REVIEW",
  "LOW_CONFIDENCE_REVIEW",
  "DRAFT_MODE_REVIEW",
  "HUMAN_AGENT_REVIEW",
  "AMBIGUOUS_DELIVERY",
] as const;
export type TakeoverReason = (typeof TAKEOVER_REASONS)[number];
export const isTakeoverReason = literalGuard(TAKEOVER_REASONS);

/** Review requested for a normal-window draft, or for an explicitly human-initiated Human Agent send. */
export const REVIEW_MODES = ["NORMAL", "HUMAN_AGENT"] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];

export type Actor =
  | { readonly kind: "USER"; readonly userId: UserId }
  | { readonly kind: "NATIVE_APP" }
  | { readonly kind: "SYSTEM" };

/**
 * Who currently owns the conversation. Separate from `AiMode` (automation policy). Human activity always
 * wins: any state other than NONE blocks automated sending (ADR-004).
 */
export type HumanTakeoverState =
  | { readonly state: "NONE" }
  | {
      readonly state: "REVIEW_REQUIRED";
      readonly reason: TakeoverReason;
      readonly reviewMode: ReviewMode;
      readonly since: Date;
    }
  | {
      readonly state: "HUMAN_ACTIVE";
      readonly reason: TakeoverReason;
      readonly since: Date;
      readonly actor?: Actor;
      /** Optional configured pause end; resuming still requires the application's resume checks. */
      readonly pausedUntil?: Date;
    };

export const HUMAN_TAKEOVER_STATES = ["NONE", "REVIEW_REQUIRED", "HUMAN_ACTIVE"] as const satisfies readonly HumanTakeoverState["state"][];

export const NO_TAKEOVER: HumanTakeoverState = { state: "NONE" };

/** Automation may act only when nobody has taken over or requested review. */
export function allowsAutomatedSend(takeover: HumanTakeoverState): boolean {
  return takeover.state === "NONE";
}

/**
 * On whose authority an outbound reply would be sent.
 *
 * Automation has no actor to name, and that is the whole difference: an approval carries the person who
 * gave it, when they gave it, and which send they authorized. A background job cannot construct the human
 * variant out of nothing, which is the point — an authority is something that was granted, not something a
 * later layer can decide it has.
 */
export type SendAuthority =
  | { readonly kind: "AUTOMATED" }
  | {
      readonly kind: "HUMAN_APPROVED";
      readonly actor: Actor;
      readonly approvedAt: Date;
      /**
       * Which send the person authorized: an ordinary reply, or the provider's human-support path.
       *
       * Carried because the two are not interchangeable. Someone approving a normal reply has not agreed
       * to a tagged human-agent send, and ADR-014 turns on that difference.
       */
      readonly reviewMode: ReviewMode;
    };

/** Automation, the strict case, named so it does not have to be spelled out at every call site. */
export const AUTOMATED_AUTHORITY: SendAuthority = { kind: "AUTOMATED" };

/**
 * Whether two actors are the same person or the same kind of non-person.
 *
 * Two `NATIVE_APP` or `SYSTEM` actors are indistinguishable by construction; two users are the same only
 * when the id matches.
 */
export function isSameActor(left: Actor, right: Actor): boolean {
  if (left.kind === "USER" && right.kind === "USER") {
    return left.userId === right.userId;
  }
  return left.kind === right.kind;
}

/**
 * Whether a human-active takeover is the one that authorized this send.
 *
 * Approving a reply takes the conversation, so the approver's own takeover must not then block the reply
 * they just approved. A takeover by somebody *else* is a different matter: they now own the conversation,
 * and an approval from before that does not reach past it.
 */
export function takeoverAuthorizes(takeover: HumanTakeoverState, authority: SendAuthority): boolean {
  if (authority.kind !== "HUMAN_APPROVED") {
    return false;
  }
  if (takeover.state === "REVIEW_REQUIRED") {
    // The review is what this approval resolved.
    return true;
  }
  return takeover.state === "HUMAN_ACTIVE" && takeover.actor !== undefined && isSameActor(takeover.actor, authority.actor);
}
