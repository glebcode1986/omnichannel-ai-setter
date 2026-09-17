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
