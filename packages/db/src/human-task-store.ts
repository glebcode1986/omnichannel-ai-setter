/**
 * Work for a person (GOALS_FOLLOWUPS.md, Issue #55).
 *
 * The one invariant this file exists to hold is a negative: **completing or dismissing a task never sends
 * a customer a message.** It is not enforced by a check in `completeTask`, because a check can be moved.
 * It holds because `human_tasks` has no draft, no operation id, no delivery relation and no message text —
 * there is nothing here for a send path to attach to, and a future writer who wanted to make "mark done"
 * deliver something would have to add a column and explain why in a reviewed diff.
 *
 * Tasks are therefore the safe place for a model to propose work. `sourceDraftId` records which reply
 * suggested one, and a model raising fifty tasks is fifty things in somebody's queue rather than fifty
 * messages to customers. That asymmetry is deliberate: the product's model may ask people to do things,
 * and may not ask customers for anything without the gates.
 */
import type { HumanTaskKind, HumanTaskStatus } from "@omnichannel/domain";

import type { DbExecutor } from "./client";
import { canActOnBusinessProfile, profileScopeOf, usersWhoCanActOnBusinessProfile, type BusinessProfileContext } from "./tenancy";

export type TaskOutcome =
  | { readonly status: "CREATED"; readonly id: string }
  | { readonly status: "UPDATED"; readonly id: string }
  | { readonly status: "DONE"; readonly id: string }
  | { readonly status: "DISMISSED"; readonly id: string }
  | { readonly status: "GONE" }
  | { readonly status: "REFUSED"; readonly reason: string };

export interface TaskView {
  readonly id: string;
  readonly kind: HumanTaskKind;
  readonly status: HumanTaskStatus;
  readonly title: string;
  readonly detail: string | null;
  readonly dueAt: Date | null;
  readonly conversationId: string | null;
  readonly assignedUserId: string | null;
  readonly assignedName: string | null;
  readonly sourceDraftId: string | null;
  readonly completedByName: string | null;
  readonly completedAt: Date | null;
  readonly dismissedReason: string | null;
  readonly createdAt: Date;
}

const taskSelect = {
  id: true,
  kind: true,
  status: true,
  title: true,
  detail: true,
  dueAt: true,
  conversationId: true,
  assignedUserId: true,
  sourceDraftId: true,
  completedByUserId: true,
  completedAt: true,
  dismissedReason: true,
  createdAt: true,
  assignedUser: { select: { name: true } },
  completedByUser: { select: { name: true } },
} as const;

/**
 * Turns a row into a view, naming only the people this profile may know about.
 *
 * `authorized` is the set of users who may act on this Business Profile *now*. A name outside it is
 * dropped while the id it belongs to is kept: the operator still sees that the task is assigned and to
 * whom it is not available, which is the fact they need in order to reassign it, and they learn no
 * stranger's name doing so. A row written before the assignment gate existed, and a row whose assignee's
 * grant was later revoked, are the same case from this side (#55, Astra's second P1 on PR #82).
 */
function toView(row: {
  id: string;
  kind: HumanTaskKind;
  status: HumanTaskStatus;
  title: string;
  detail: string | null;
  dueAt: Date | null;
  conversationId: string | null;
  assignedUserId: string | null;
  sourceDraftId: string | null;
  completedAt: Date | null;
  dismissedReason: string | null;
  createdAt: Date;
  assignedUser: { name: string | null } | null;
  completedByUser: { name: string | null } | null;
  completedByUserId?: string | null;
}, authorized: ReadonlySet<string>): TaskView {
  const nameOf = (userId: string | null | undefined, user: { name: string | null } | null): string | null =>
    userId !== null && userId !== undefined && authorized.has(userId) ? (user?.name ?? null) : null;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    title: row.title,
    detail: row.detail,
    dueAt: row.dueAt,
    conversationId: row.conversationId,
    assignedUserId: row.assignedUserId,
    assignedName: nameOf(row.assignedUserId, row.assignedUser),
    sourceDraftId: row.sourceDraftId,
    // The same rule for whoever closed it: a scoped read reveals no identity from outside its own profile,
    // whichever column the identity reached it through.
    completedByName: nameOf(row.completedByUserId, row.completedByUser),
    completedAt: row.completedAt,
    dismissedReason: row.dismissedReason,
    createdAt: row.createdAt,
  };
}

/** A person raises a task. */
export async function createTask(
  db: DbExecutor,
  context: BusinessProfileContext,
  input: {
    readonly kind: HumanTaskKind;
    readonly title: string;
    readonly detail?: string;
    readonly dueAt?: Date;
    readonly conversationId?: string;
    readonly assignedUserId?: string;
  },
): Promise<TaskOutcome> {
  const scope = profileScopeOf(context);
  if (input.title.trim() === "") {
    return { status: "REFUSED", reason: "a task needs a title somebody can act on" };
  }
  if (input.conversationId !== undefined) {
    const conversation = await db.conversation.findFirst({ where: { ...scope, id: input.conversationId }, select: { id: true } });
    if (conversation === null) {
      return { status: "GONE" };
    }
  }
  if (input.assignedUserId !== undefined) {
    const refusal = await assigneeRefusal(db, context, input.assignedUserId);
    if (refusal !== undefined) {
      return refusal;
    }
  }
  const created = await db.humanTask.create({
    data: {
      ...scope,
      kind: input.kind,
      status: "OPEN",
      title: input.title.trim(),
      createdByUserId: context.userId,
      ...(input.detail === undefined || input.detail.trim() === "" ? {} : { detail: input.detail.trim() }),
      ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      ...(input.assignedUserId === undefined ? {} : { assignedUserId: input.assignedUserId }),
    },
    select: { id: true },
  });
  return { status: "CREATED", id: created.id };
}

/**
 * A model proposes a task.
 *
 * Safe in a way a proposed *message* is not, which is the whole point of the separation: the worst a model
 * can do here is give somebody more to read. It must still name the draft it came from, so an operator can
 * see the reply that produced it before acting on it.
 */
export async function suggestTask(
  db: DbExecutor,
  context: BusinessProfileContext,
  input: {
    readonly kind: HumanTaskKind;
    readonly title: string;
    readonly sourceDraftId: string;
    readonly detail?: string;
    readonly conversationId?: string;
  },
): Promise<TaskOutcome> {
  const scope = profileScopeOf(context);
  if (input.title.trim() === "") {
    return { status: "REFUSED", reason: "a task needs a title somebody can act on" };
  }
  const created = await db.humanTask.create({
    data: {
      ...scope,
      kind: input.kind,
      status: "OPEN",
      title: input.title.trim(),
      sourceDraftId: input.sourceDraftId,
      ...(input.detail === undefined || input.detail.trim() === "" ? {} : { detail: input.detail.trim() }),
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
    },
    select: { id: true },
  });
  return { status: "CREATED", id: created.id };
}

/**
 * Somebody did it.
 *
 * Note what this function does not do, and cannot: there is no draft to schedule, no coordinator to call
 * and no conversation write at all. Marking a task done changes one row's status and nothing about what
 * the customer sees. A follow-up is how a customer gets messaged, and a follow-up is a different table
 * with a different gate.
 */
export async function completeTask(db: DbExecutor, context: BusinessProfileContext, taskId: string, at = new Date()): Promise<TaskOutcome> {
  const scope = profileScopeOf(context);
  const changed = await db.humanTask.updateMany({
    where: { ...scope, id: taskId, status: "OPEN" },
    data: { status: "DONE", completedByUserId: context.userId, completedAt: at },
  });
  return changed.count === 0 ? { status: "GONE" } : { status: "DONE", id: taskId };
}

/** Somebody decided it did not need doing. Also sends nothing, for the same structural reason. */
export async function dismissTask(
  db: DbExecutor,
  context: BusinessProfileContext,
  taskId: string,
  reason: string,
  at = new Date(),
): Promise<TaskOutcome> {
  const scope = profileScopeOf(context);
  if (reason.trim() === "") {
    // A dismissal is a decision, and a decision with no reason is one nobody can review.
    return { status: "REFUSED", reason: "say why this task is not needed" };
  }
  const changed = await db.humanTask.updateMany({
    where: { ...scope, id: taskId, status: "OPEN" },
    data: { status: "DISMISSED", completedByUserId: context.userId, completedAt: at, dismissedReason: reason.trim() },
  });
  return changed.count === 0 ? { status: "GONE" } : { status: "DISMISSED", id: taskId };
}

/** Hands a task to somebody, or takes it back. */
export async function assignTask(
  db: DbExecutor,
  context: BusinessProfileContext,
  taskId: string,
  assignedUserId: string | null,
): Promise<TaskOutcome> {
  const scope = profileScopeOf(context);
  if (assignedUserId !== null) {
    // Checked on the way in as well as at creation. A reassignment is the same decision made later, and a
    // guard on only one of the two paths is a guard on neither: grants change, people leave the
    // workspace, and the path that moves an existing task is the one somebody reaches for afterwards.
    const refusal = await assigneeRefusal(db, context, assignedUserId);
    if (refusal !== undefined) {
      return refusal;
    }
  }
  const changed = await db.humanTask.updateMany({ where: { ...scope, id: taskId, status: "OPEN" }, data: { assignedUserId } });
  return changed.count === 0 ? { status: "GONE" } : { status: "UPDATED", id: taskId };
}

/**
 * Refuses an assignee who cannot reach the Business Profile the task belongs to.
 *
 * Two failures at once, which is why this fails closed rather than warning. The task sits in a queue its
 * assignee cannot open — so nobody does it, and the list shows it as somebody's work. And `listTasks`
 * joins the assignee's name, so a profile-scoped read would carry the name of a person from another
 * workspace to whoever can read this one: an identifier the reader had no business learning.
 *
 * Membership alone is not the test. A member whose scope is `SELECTED` without this profile is exactly as
 * unable to act as somebody from another company, and the schema cannot tell them apart — `human_tasks`
 * references global `users(id)`, so every foreign user id is a valid foreign key.
 *
 * One refusal for every reason: not a member, not granted this profile, no such user. An assignment form
 * that answered differently would be a way to find out who exists.
 */
async function assigneeRefusal(db: DbExecutor, context: BusinessProfileContext, assignedUserId: string): Promise<TaskOutcome | undefined> {
  const allowed = await canActOnBusinessProfile(db, {
    workspaceId: context.workspaceId,
    userId: assignedUserId,
    businessProfileId: context.businessProfileId,
  });
  return allowed ? undefined : { status: "REFUSED", reason: "a task can only be assigned to somebody who works on this Business Profile" };
}

export interface TaskFilter {
  readonly status?: HumanTaskStatus;
  readonly assignedUserId?: string;
  readonly conversationId?: string;
  readonly kind?: HumanTaskKind;
}

/** The task queue, soonest due first and undated last. */
export async function listTasks(
  db: DbExecutor,
  context: BusinessProfileContext,
  filter: TaskFilter = {},
  limit = 100,
): Promise<readonly TaskView[]> {
  const scope = profileScopeOf(context);
  const rows = await db.humanTask.findMany({
    where: {
      ...scope,
      ...(filter.status === undefined ? {} : { status: filter.status }),
      ...(filter.assignedUserId === undefined ? {} : { assignedUserId: filter.assignedUserId }),
      ...(filter.conversationId === undefined ? {} : { conversationId: filter.conversationId }),
      ...(filter.kind === undefined ? {} : { kind: filter.kind }),
    },
    // Undated tasks last rather than first: a task with no deadline is not the most urgent one.
    orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
    take: Math.min(Math.max(Math.trunc(limit), 1), 500),
    select: taskSelect,
  });
  // Asked once for the whole page, about everyone it names, and asked *now* rather than trusted from when
  // each row was written — grants change, and a stored name does not hear about it.
  const authorized = await usersWhoCanActOnBusinessProfile(
    db,
    { workspaceId: scope.workspaceId, businessProfileId: scope.businessProfileId },
    rows.flatMap((row) => [row.assignedUserId, row.completedByUserId].filter((userId): userId is string => userId !== null)),
  );
  return rows.map((row) => toView(row, authorized));
}
