import { literalGuard } from "./enum";

/**
 * What a conversation is *for*, what happens next, and what is scheduled (GOALS_FOLLOWUPS.md, Issue #55).
 *
 * Four concepts, deliberately four and not one:
 *
 * - a **goal** is what this conversation is trying to achieve;
 * - a **next action** is the immediate step towards it — it lives on the conversation as the lead record's
 *   own field, because a lead's "what's next" and a conversation's are the same question and two places to
 *   answer it would give two answers;
 * - a **follow-up** is a scheduled attempt to message the customer, which may never happen;
 * - a **human task** is work for a person, which never messages anybody at all.
 *
 * Collapsing any two of these produces the product this issue exists to prevent. A goal that implied a
 * schedule would chase customers on its own; a follow-up that doubled as a task would let "mark done" send
 * a message; a task that could send would be an outreach queue wearing a to-do list's clothes.
 */

/**
 * The goals a conversation can have.
 *
 * A closed list, because a goal is something the assistant's behaviour keys off and the review queue
 * reports on — not a free-text note, which is what `AutomationPolicy.businessGoal` already is at the
 * Business Profile level. That one says what the business is for; this says what *this thread* is for.
 */
export const CONVERSATION_GOALS = [
  "ANSWER_QUESTION",
  "BOOK_APPOINTMENT",
  "QUALIFY_LEAD",
  "COLLECT_DETAILS",
  "CONFIRM_ATTENDANCE",
  "RESOLVE_COMPLAINT",
  /** Explicitly nothing further: the conversation is done and no follow-up may be scheduled against it. */
  "NONE",
] as const;
export type ConversationGoalKind = (typeof CONVERSATION_GOALS)[number];
export const isConversationGoalKind = literalGuard(CONVERSATION_GOALS);

/**
 * Whether the goal is still being pursued.
 *
 * `ACHIEVED` and `ABANDONED` are both terminal and both stop follow-ups, but they are not the same fact:
 * one is a success worth counting and the other is a decision worth reviewing.
 */
export const GOAL_STATUSES = ["ACTIVE", "ACHIEVED", "ABANDONED"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];
export const isGoalStatus = literalGuard(GOAL_STATUSES);

/** A goal that no longer justifies messaging anybody. */
export function isTerminalGoalStatus(status: GoalStatus): boolean {
  return status !== "ACTIVE";
}

/**
 * Where a follow-up is in its life.
 *
 * `BLOCKED` is separate from `CANCELLED` on purpose: blocked means a gate refused it *this time* and the
 * attempt was spent, which is a thing an operator may want to look at; cancelled means it will never run.
 */
export const FOLLOW_UP_STATUSES = ["PENDING", "SENT", "BLOCKED", "CANCELLED", "SUPERSEDED", "EXHAUSTED"] as const;
export type FollowUpStatus = (typeof FOLLOW_UP_STATUSES)[number];
export const isFollowUpStatus = literalGuard(FOLLOW_UP_STATUSES);

export function isTerminalFollowUpStatus(status: FollowUpStatus): boolean {
  return status !== "PENDING";
}

/**
 * Why a follow-up stopped.
 *
 * Every terminal status names one, and the list is closed so an operator reading "we did not chase this
 * customer" gets an answer rather than a shrug. Each of these is a case the issue's Tests section names.
 */
export const FOLLOW_UP_STOP_REASONS = [
  /** The customer wrote back, so the follow-up answers a question that has moved on. */
  "NEW_INBOUND",
  /** A person is handling this conversation. Automation does not interrupt them. */
  "HUMAN_TAKEOVER",
  /** A draft is waiting for somebody, and a second outbound would pre-empt their decision. */
  "REVIEW_PENDING",
  /** The customer asked not to be messaged, or the scope is suspended. */
  "OPTED_OUT",
  /** The Workspace is no longer entitled to send on this channel. */
  "ENTITLEMENT_LOST",
  /** The channel cannot carry this message now: window closed, template required, account unhealthy. */
  "CHANNEL_INELIGIBLE",
  /** The goal was achieved or abandoned, so there is nothing to follow up about. */
  "GOAL_TERMINAL",
  /** The conversation moved on far enough that the anchor this follow-up was planned against is stale. */
  "STALE_ANCHOR",
  /** The bounded attempts are used up. This is the one that stops chasing. */
  "MAX_ATTEMPTS",
  /** A person cancelled it. */
  "HUMAN_CANCELLED",
  /** A newer follow-up replaced it. */
  "SUPERSEDED_BY_NEWER",
  /** The conversation itself was closed. */
  "CONVERSATION_CLOSED",
] as const;
export type FollowUpStopReason = (typeof FOLLOW_UP_STOP_REASONS)[number];
export const isFollowUpStopReason = literalGuard(FOLLOW_UP_STOP_REASONS);

/**
 * The ceiling on attempts, whatever a caller asks for.
 *
 * "No unlimited chasing" is the issue's own wording and this is where it stops being a hope. Three is the
 * default and five the hard maximum: past that the difference between following up and harassing somebody
 * is a matter of opinion, and this product does not get to hold the opinion.
 */
export const DEFAULT_MAX_FOLLOW_UP_ATTEMPTS = 3;
export const HARD_MAX_FOLLOW_UP_ATTEMPTS = 5;

export function boundedMaxAttempts(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return DEFAULT_MAX_FOLLOW_UP_ATTEMPTS;
  }
  return Math.min(Math.max(Math.trunc(requested), 1), HARD_MAX_FOLLOW_UP_ATTEMPTS);
}

/** What a person has to do, and whether they have done it. */
export const HUMAN_TASK_STATUSES = ["OPEN", "DONE", "DISMISSED"] as const;
export type HumanTaskStatus = (typeof HUMAN_TASK_STATUSES)[number];
export const isHumanTaskStatus = literalGuard(HUMAN_TASK_STATUSES);

/**
 * Why a task exists.
 *
 * Kinds rather than free text, so a queue of tasks can be triaged — and every one of them is something a
 * *person* does. There is deliberately no kind that means "send a message": a task that could send would
 * make "mark done" a send button, which is the confusion this whole separation exists to prevent.
 */
export const HUMAN_TASK_KINDS = [
  "CALL_CUSTOMER",
  "CHECK_AVAILABILITY",
  "PREPARE_QUOTE",
  "VERIFY_DETAILS",
  "ESCALATE_INTERNALLY",
  "REVIEW_CONVERSATION",
  "OTHER",
] as const;
export type HumanTaskKind = (typeof HUMAN_TASK_KINDS)[number];
export const isHumanTaskKind = literalGuard(HUMAN_TASK_KINDS);

/**
 * Whether a local hour is inside the Business Profile's own sending window.
 *
 * Follow-ups are scheduled in the *profile's* daypart, not the server's and not the customer's: the
 * business decides when it is willing to message people, and that is a setting it already has. The hours
 * are half-open — `[startHour, endHour)` — so 9 to 18 means nine in the morning up to but not including
 * six in the evening, and two adjacent windows cannot both claim the same hour.
 */
export function isWithinDaypart(localHour: number, startHour: number, endHour: number): boolean {
  if (startHour === endHour) {
    // A zero-width window sends nothing. Treating it as "all day" would turn a misconfiguration into
    // unattended messages at three in the morning.
    return false;
  }
  return startHour < endHour ? localHour >= startHour && localHour < endHour : localHour >= startHour || localHour < endHour;
}
