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
import { profileScopeOf, type BusinessProfileContext } from "./tenancy";

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
  completedAt: true,
  dismissedReason: true,
  createdAt: true,
  assignedUser: { select: { name: true } },
  completedByUser: { select: { name: true } },
} as const;

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
}): TaskView {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    title: row.title,
    detail: row.detail,
    dueAt: row.dueAt,
    conversationId: row.conversationId,
    assignedUserId: row.assignedUserId,
    assignedName: row.assignedUser?.name ?? null,
    sourceDraftId: row.sourceDraftId,
    completedByName: row.completedByUser?.name ?? null,
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
  const changed = await db.humanTask.updateMany({ where: { ...scope, id: taskId, status: "OPEN" }, data: { assignedUserId } });
  return changed.count === 0 ? { status: "GONE" } : { status: "UPDATED", id: taskId };
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
  return rows.map(toView);
}
