/**
 * What a conversation is for (GOALS_FOLLOWUPS.md, Issue #55).
 *
 * A goal carries **no schedule**. That is the first of the separations this task rests on: a goal that
 * implied a due date would chase customers by existing, and the decision to message somebody would be made
 * by whoever set the goal rather than by the gates that exist to make it safely.
 *
 * A model may propose a goal and a person confirms it, which is the same rule the customer-memory work
 * established for facts — and for the same reason. The difference is what the two produce: a proposed fact
 * is invisible to anything reading memory as authority, and a proposed goal cannot be the conversation's
 * primary goal. Neither can become the business's own position by the model saying so twice.
 *
 * The **next action** is deliberately not here. `conversations.next_action` and `next_action_at` already
 * exist from the leads work, and a lead's "what happens next" and a conversation's are the same question.
 * A second place to answer it would give two answers, and the one an operator saw would depend on which
 * screen they opened.
 */
import type { ConversationGoalKind, GoalStatus } from "@omnichannel/domain";

import type { DbClient, DbExecutor } from "./client";
import { profileScopeOf, type BusinessProfileContext } from "./tenancy";

export type GoalOutcome =
  | { readonly status: "SET"; readonly id: string }
  | { readonly status: "SUGGESTED"; readonly id: string }
  | { readonly status: "UNCHANGED"; readonly id: string }
  | { readonly status: "ACHIEVED"; readonly id: string }
  | { readonly status: "ABANDONED"; readonly id: string }
  | { readonly status: "GONE" }
  | { readonly status: "REFUSED"; readonly reason: string };

export interface GoalView {
  readonly id: string;
  readonly kind: ConversationGoalKind;
  readonly isPrimary: boolean;
  readonly status: GoalStatus;
  readonly source: string;
  readonly setByName: string | null;
  readonly sourceDraftId: string | null;
  readonly note: string | null;
  readonly achievedAt: Date | null;
  readonly abandonedAt: Date | null;
  readonly createdAt: Date;
}

const goalSelect = {
  id: true,
  kind: true,
  isPrimary: true,
  status: true,
  source: true,
  sourceDraftId: true,
  note: true,
  achievedAt: true,
  abandonedAt: true,
  createdAt: true,
  setByUser: { select: { name: true } },
} as const;

function toView(row: {
  id: string;
  kind: ConversationGoalKind;
  isPrimary: boolean;
  status: GoalStatus;
  source: string;
  sourceDraftId: string | null;
  note: string | null;
  achievedAt: Date | null;
  abandonedAt: Date | null;
  createdAt: Date;
  setByUser: { name: string | null } | null;
}): GoalView {
  return {
    id: row.id,
    kind: row.kind,
    isPrimary: row.isPrimary,
    status: row.status,
    source: row.source,
    setByName: row.setByUser?.name ?? null,
    sourceDraftId: row.sourceDraftId,
    note: row.note,
    achievedAt: row.achievedAt,
    abandonedAt: row.abandonedAt,
    createdAt: row.createdAt,
  };
}

/**
 * A person sets the conversation's primary goal, retiring whatever it replaces.
 *
 * One transaction, because a partial unique index allows exactly one active primary goal and two
 * statements would either collide or leave the conversation with two answers to "what are we trying to do
 * here" in between. The old goal becomes `ABANDONED` rather than disappearing: what a conversation *used*
 * to be for is how somebody later understands a follow-up that went out under it.
 *
 * Retiring the old goal also settles its pending follow-ups. A follow-up outliving the goal that justified
 * it is the precise shape of unbounded outreach: work scheduled for a reason nobody holds any more.
 */
export async function setPrimaryGoal(
  db: DbClient,
  context: BusinessProfileContext,
  input: {
    readonly conversationId: string;
    readonly kind: ConversationGoalKind;
    readonly note?: string;
    readonly at?: Date;
  },
): Promise<GoalOutcome> {
  const scope = profileScopeOf(context);
  const at = input.at ?? new Date();

  return db.$transaction(async (tx) => {
    const conversation = await tx.conversation.findFirst({
      where: { ...scope, id: input.conversationId },
      select: { id: true },
    });
    if (conversation === null) {
      return { status: "GONE" };
    }

    const current = await tx.conversationGoal.findFirst({
      where: { ...scope, conversationId: input.conversationId, status: "ACTIVE", isPrimary: true },
      select: { id: true, kind: true },
    });
    if (current !== null && current.kind === input.kind) {
      // Setting the goal it already has is not a change. Writing a new row would retire a goal in favour
      // of itself and lose the note and the moment somebody actually decided.
      return { status: "UNCHANGED", id: current.id };
    }

    if (current !== null) {
      await tx.conversationGoal.update({ where: { id: current.id }, data: { status: "ABANDONED", abandonedAt: at } });
      await settleFollowUpsForGoal(tx, current.id, "GOAL_TERMINAL", at);
    }

    const created = await tx.conversationGoal.create({
      data: {
        ...scope,
        conversationId: input.conversationId,
        kind: input.kind,
        isPrimary: true,
        status: "ACTIVE",
        source: "HUMAN_SET",
        setByUserId: context.userId,
        ...(input.note === undefined || input.note.trim() === "" ? {} : { note: input.note.trim() }),
      },
      select: { id: true },
    });
    return { status: "SET", id: created.id };
  });
}

/**
 * A model's reading of what this conversation is for.
 *
 * Always secondary and always `AI_SUGGESTED`, whatever the model thought. A proposal cannot be the
 * conversation's primary goal, which is what stops a follow-up being justified by something nobody agreed
 * to: `planFollowUp` only accepts a goal a person set.
 */
export async function suggestGoal(
  db: DbClient,
  context: BusinessProfileContext,
  input: { readonly conversationId: string; readonly kind: ConversationGoalKind; readonly sourceDraftId: string; readonly note?: string },
): Promise<GoalOutcome> {
  const scope = profileScopeOf(context);

  const conversation = await db.conversation.findFirst({ where: { ...scope, id: input.conversationId }, select: { id: true } });
  if (conversation === null) {
    return { status: "GONE" };
  }
  const created = await db.conversationGoal.create({
    data: {
      ...scope,
      conversationId: input.conversationId,
      kind: input.kind,
      // Never primary. A CHECK requires the draft id, so a suggestion always names the reply it came from.
      isPrimary: false,
      status: "ACTIVE",
      source: "AI_SUGGESTED",
      sourceDraftId: input.sourceDraftId,
      ...(input.note === undefined || input.note.trim() === "" ? {} : { note: input.note.trim() }),
    },
    select: { id: true },
  });
  return { status: "SUGGESTED", id: created.id };
}

/**
 * The goal was reached, or given up on.
 *
 * Either way its pending follow-ups settle in the same transaction. "Goal achieved cancels pending work"
 * is one of the issue's required behaviours, and doing it here rather than at execution time means the
 * cancellation is a fact in the database the moment somebody records the outcome — not something the next
 * worker happens to notice.
 */
export async function closeGoal(
  db: DbClient,
  context: BusinessProfileContext,
  goalId: string,
  outcome: "ACHIEVED" | "ABANDONED",
  at = new Date(),
): Promise<GoalOutcome> {
  const scope = profileScopeOf(context);

  return db.$transaction(async (tx) => {
    const goal = await tx.conversationGoal.findFirst({ where: { ...scope, id: goalId, status: "ACTIVE" }, select: { id: true, kind: true } });
    if (goal === null) {
      return { status: "GONE" };
    }
    if (outcome === "ACHIEVED" && goal.kind === "NONE") {
      // "Nothing further" is not a thing that can be achieved, and a CHECK refuses it too. Allowing it
      // would let a follow-up be justified by a goal saying there is nothing to follow up about.
      return { status: "REFUSED", reason: "a goal of NONE cannot be achieved" };
    }
    await tx.conversationGoal.update({
      where: { id: goalId },
      data: outcome === "ACHIEVED" ? { status: "ACHIEVED", achievedAt: at } : { status: "ABANDONED", abandonedAt: at },
    });
    await settleFollowUpsForGoal(tx, goalId, "GOAL_TERMINAL", at);
    return { status: outcome, id: goalId };
  });
}

/** Stops every pending follow-up hanging off one goal. Shared, so both paths that retire a goal agree. */
/**
 * How much of a conversation's goal history one read carries.
 *
 * A window for a reader. What makes it safe is that nothing is derived from it: the primary goal, which is
 * the one value a decision depends on, has its own query.
 */
const GOAL_HISTORY_WINDOW = 50;

async function settleFollowUpsForGoal(tx: DbExecutor, goalId: string, reason: "GOAL_TERMINAL", at: Date): Promise<number> {
  const stopped = await tx.followUp.updateMany({
    where: { goalId, status: "PENDING" },
    data: { status: "CANCELLED", stopReason: reason, settledAt: at },
  });
  return stopped.count;
}

/**
 * The goals of one conversation, current first — and the primary one, asked for directly.
 *
 * `primary` used to be found inside `all`, which is a window of the fifty newest. A conversation with
 * more goals than that would have reported no primary goal while an active one existed, and nothing in
 * the answer could have said so: the caller sees `undefined`, which also means "there isn't one". That is
 * the shape worth avoiding — a derived authority value computed inside a bound chosen for display.
 *
 * Its own query cannot miss it and cannot be ambiguous: `conversation_goals_active_primary_key` is a
 * partial unique index over (workspace, profile, conversation) where the row is `ACTIVE` and primary, so
 * there is at most one and the database is what guarantees it.
 *
 * `all` stays a window, and is a window for a reader rather than for a decision — nothing in the product
 * derives anything from it.
 */
export async function readGoals(
  db: DbExecutor,
  context: BusinessProfileContext,
  conversationId: string,
): Promise<{ readonly primary: GoalView | undefined; readonly all: readonly GoalView[] }> {
  const scope = profileScopeOf(context);
  const [rows, primary] = await Promise.all([
    db.conversationGoal.findMany({
      where: { ...scope, conversationId },
      orderBy: [{ createdAt: "desc" }],
      take: GOAL_HISTORY_WINDOW,
      select: goalSelect,
    }),
    db.conversationGoal.findFirst({ where: { ...scope, conversationId, isPrimary: true, status: "ACTIVE" }, select: goalSelect }),
  ]);
  return { primary: primary === null ? undefined : toView(primary), all: rows.map(toView) };
}

/**
 * The next step a person intends, on the conversation itself.
 *
 * Here rather than in its own table for the reason in the file comment: this *is* the lead record's next
 * action, and the leads board and the conversation must not be able to disagree about it. It is free text
 * with an optional moment, and it schedules nothing — a next action is what somebody means to do, and a
 * follow-up is a thing the system will attempt.
 */
export async function setNextAction(
  db: DbExecutor,
  context: BusinessProfileContext,
  input: { readonly conversationId: string; readonly nextAction: string | null; readonly nextActionAt?: Date | null },
): Promise<GoalOutcome> {
  const scope = profileScopeOf(context);
  const text = input.nextAction === null ? null : input.nextAction.trim();
  if (text !== null && text === "") {
    return { status: "REFUSED", reason: "a next action needs either words or nothing at all" };
  }
  const changed = await db.conversation.updateMany({
    where: { ...scope, id: input.conversationId },
    data: {
      nextAction: text,
      // Clearing the action clears its moment. A date with nothing attached is a reminder about nothing.
      ...(text === null ? { nextActionAt: null } : input.nextActionAt === undefined ? {} : { nextActionAt: input.nextActionAt }),
    },
  });
  return changed.count === 0 ? { status: "GONE" } : { status: "SET", id: input.conversationId };
}
