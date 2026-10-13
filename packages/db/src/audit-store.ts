/**
 * A searchable, append-only record of the material things people do (Issue #34).
 *
 * Three decisions shape this file.
 *
 * **Appending is not optional and not separable.** `recordAuditEvent` takes an executor, not a client, so
 * a caller inside a transaction writes the audit row in the same transaction as the change it describes. A
 * crash between the two would otherwise leave a mode change nobody appears to have made, which is the one
 * question this table exists to answer.
 *
 * **Nothing here can edit or remove a row.** There is no update and no delete, and the database enforces
 * that with a trigger rather than trusting this file: a correction is a new row. That is what makes the log
 * worth reading — a row says what was recorded at the time, and a reader never has to wonder whether
 * somebody tidied it since.
 *
 * **An Agent's search must not reveal that sensitive rows exist.** Membership, role and channel-credential
 * events are admin-only, and "admin-only" has to mean absent rather than redacted: a row that appears as
 * `***` still discloses that somebody's access changed at 14:02, which is most of what was being hidden.
 */
import { ADMIN_ONLY_AUDIT_KINDS, AUDIT_EVENT_KINDS, type AuditActorKind, type AuditEventKind } from "@omnichannel/domain";

import type { DbExecutor } from "./client";
import {
  authorizedBusinessProfileFilter,
  profileScopeOf,
  scopeOf,
  WORKSPACE_ADMIN_ROLES,
  type BusinessProfileContext,
  type WorkspaceContext,
} from "./tenancy";

export type { AuditActorKind, AuditEventKind };

export interface AuditEventInput {
  readonly kind: AuditEventKind;
  /** What the action was about, in the words the person would search for. */
  readonly summary: string;
  readonly subjectType: string;
  readonly subjectId: string;
  /** Absent for an action nobody took: reconciliation and the scheduler act on their own. */
  readonly actorUserId?: string;
  readonly channelAccountId?: string;
  readonly conversationId?: string;
  readonly detail?: Record<string, unknown>;
  readonly occurredAt?: Date;
}

export interface AuditEventView {
  readonly id: string;
  readonly kind: AuditEventKind;
  readonly actorKind: AuditActorKind;
  readonly actorName: string | null;
  readonly occurredAt: Date;
  readonly summary: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly businessProfileId: string | null;
  readonly channelAccountId: string | null;
  readonly conversationId: string | null;
  readonly sensitive: boolean;
  readonly detail: unknown;
}

/**
 * Appends one event, inside the caller's transaction.
 *
 * Sensitivity is derived, not passed. A caller that could choose would eventually file a role change as
 * ordinary work — by accident, in a hurry — and the CHECK would reject the insert, taking the actual
 * change down with it. Deriving it means the only way to mark something sensitive is to give it a kind
 * that is.
 */
export async function recordAuditEvent(
  db: DbExecutor,
  context: BusinessProfileContext,
  input: AuditEventInput,
): Promise<{ readonly id: string }> {
  const scope = profileScopeOf(context);
  return writeAuditEvent(db, scope.workspaceId, scope.businessProfileId, input);
}

/**
 * The workspace-level variant, for actions that belong to no Business Profile.
 *
 * A membership or role change is the obvious case: filing it under one profile would hide it from the
 * workspace view, which is the only place it makes sense to read.
 */
export async function recordWorkspaceAuditEvent(
  db: DbExecutor,
  context: WorkspaceContext,
  input: AuditEventInput,
): Promise<{ readonly id: string }> {
  return writeAuditEvent(db, scopeOf(context), null, input);
}

/**
 * The variant for work that runs without anybody asking in that moment (#57).
 *
 * A deletion is requested by a person and carried out later by a process, so the completion has no
 * session behind it — and recording it as nobody's action would lose the one fact that matters, which is
 * that it finished. The caller supplies the scope it already holds on the durable request, and the actor
 * is the person who asked rather than the process that ran.
 *
 * Scope is a parameter rather than a context because there is no context to have: inventing one so this
 * would type-check is how a background path acquires authority nobody granted.
 */
export async function recordSystemAuditEvent(
  db: DbExecutor,
  scope: { readonly workspaceId: string; readonly businessProfileId?: string },
  input: AuditEventInput,
): Promise<{ readonly id: string }> {
  return writeAuditEvent(db, scope.workspaceId, scope.businessProfileId ?? null, input);
}

async function writeAuditEvent(
  db: DbExecutor,
  workspaceId: string,
  businessProfileId: string | null,
  input: AuditEventInput,
): Promise<{ readonly id: string }> {
  const created = await db.auditEvent.create({
    data: {
      workspaceId,
      ...(businessProfileId === null ? {} : { businessProfileId }),
      kind: input.kind,
      actorKind: input.actorUserId === undefined ? "SYSTEM" : "USER",
      ...(input.actorUserId === undefined ? {} : { actorUserId: input.actorUserId }),
      summary: input.summary.trim(),
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      ...(input.channelAccountId === undefined ? {} : { channelAccountId: input.channelAccountId }),
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      sensitive: ADMIN_ONLY_AUDIT_KINDS.includes(input.kind),
      ...(input.detail === undefined ? {} : { detail: input.detail as never }),
      ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
    },
    select: { id: true },
  });
  return created;
}

export interface AuditSearch {
  readonly kinds?: readonly AuditEventKind[];
  readonly businessProfileId?: string;
  readonly channelAccountId?: string;
  readonly conversationId?: string;
  readonly actorUserId?: string;
  readonly from?: Date;
  readonly to?: Date;
  /** Matched against the summary the caller wrote, case-insensitively. */
  readonly term?: string;
  readonly limit?: number;
  readonly cursor?: { readonly occurredAt: Date; readonly id: string };
}

export interface AuditPage {
  readonly rows: readonly AuditEventView[];
  readonly nextCursor?: { readonly occurredAt: Date; readonly id: string };
  /** Whether any admin-only kind was withheld from this reader. False for an admin, always. */
  readonly restricted: boolean;
}

/**
 * The Business Profile condition for a reader, or nothing at all.
 *
 * Three distinct cases, and conflating any two of them is a disclosure or a blank page:
 * an ALL scope needs no condition; a SELECTED scope needs its profiles *or* the workspace-level rows; and
 * an explicitly requested profile needs exactly that one.
 */
function profileCondition(
  context: WorkspaceContext,
  requested: string | undefined,
): { businessProfileId?: string | null | { in: string[] } } | { OR: { businessProfileId: null | { in: string[] } }[] } {
  if (requested !== undefined) {
    return { businessProfileId: requested };
  }
  const allowed = authorizedBusinessProfileFilter(context).businessProfileId?.in;
  return allowed === undefined ? {} : { OR: [{ businessProfileId: null }, { businessProfileId: { in: [...allowed] } }] };
}

export function auditPageLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return 50;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), 200);
}

/**
 * Searches the log this member may read.
 *
 * Authorization is a filter on the query, not a check on the results: an Agent's search is a *different
 * question*, asked of the rows they may see. Filtering afterwards would mean the sensitive rows were
 * fetched, counted, and paged over — so a page of ten could come back with four, which tells the reader
 * exactly how many were hidden.
 */
export async function searchAuditEvents(db: DbExecutor, context: WorkspaceContext, search: AuditSearch = {}): Promise<AuditPage> {
  const workspaceId = scopeOf(context);
  const isAdmin = WORKSPACE_ADMIN_ROLES.includes(context.role);
  const take = auditPageLimit(search.limit ?? 50);
  // The requested kinds go through untouched, and `sensitive: false` below is what an Agent cannot see
  // past. Filtering the list first looked like defence in depth and was a bug: an Agent asking *only*
  // for an admin-only kind would be left with an empty list, which means "no kind filter" — and they
  // would get the entire log instead of nothing. A mutation that deleted the filtering is what surfaced
  // it, by being the better behaviour.
  const kinds = search.kinds ?? [];

  const window = await db.auditEvent.findMany({
    where: {
      workspaceId,
      // The profiles this member may see at all, which is narrower than the workspace for a SELECTED
      // scope. A workspace-level row has no profile and stays visible: it is not customer data.
      //
      // Built as a value rather than spread inline, because `authorizedBusinessProfileFilter` returns an
      // empty object for an ALL scope and an empty branch inside a Prisma `OR` matches *nothing*. Spread
      // straight into the disjunction it silently reduced the query to workspace-level rows only, which
      // showed an owner their membership history and none of their own profiles' work.
      ...profileCondition(context, search.businessProfileId),
      ...(isAdmin ? {} : { sensitive: false }),
      ...(kinds.length === 0 ? {} : { kind: { in: [...kinds] } }),
      ...(search.channelAccountId === undefined ? {} : { channelAccountId: search.channelAccountId }),
      ...(search.conversationId === undefined ? {} : { conversationId: search.conversationId }),
      ...(search.actorUserId === undefined ? {} : { actorUserId: search.actorUserId }),
      ...(search.from === undefined && search.to === undefined
        ? {}
        : { occurredAt: { ...(search.from === undefined ? {} : { gte: search.from }), ...(search.to === undefined ? {} : { lt: search.to }) } }),
      ...(search.term === undefined || search.term.trim() === "" ? {} : { summary: { contains: search.term.trim(), mode: "insensitive" } }),
      ...(search.cursor === undefined
        ? {}
        : {
            OR: [
              { occurredAt: { lt: search.cursor.occurredAt } },
              { occurredAt: search.cursor.occurredAt, id: { lt: search.cursor.id } },
            ],
          }),
    },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    // One more than asked, so the cursor is offered only when there is genuinely another page. A cursor
    // offered on a full last page is a "load older" link that loads nothing.
    take: take + 1,
    select: {
      id: true,
      kind: true,
      actorKind: true,
      occurredAt: true,
      summary: true,
      subjectType: true,
      subjectId: true,
      businessProfileId: true,
      channelAccountId: true,
      conversationId: true,
      sensitive: true,
      detail: true,
      actor: { select: { name: true } },
    },
  });

  const rows = window.slice(0, take).map(
    (row): AuditEventView => ({
      id: row.id,
      kind: row.kind,
      actorKind: row.actorKind,
      actorName: row.actor?.name ?? null,
      occurredAt: row.occurredAt,
      summary: row.summary,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      businessProfileId: row.businessProfileId,
      channelAccountId: row.channelAccountId,
      conversationId: row.conversationId,
      sensitive: row.sensitive,
      detail: row.detail,
    }),
  );
  const last = rows.at(-1);

  return {
    rows,
    ...(window.length > take && last !== undefined ? { nextCursor: { occurredAt: last.occurredAt, id: last.id } } : {}),
    restricted: !isAdmin,
  };
}

/** The kinds this member may filter by, so the UI offers no option that would return nothing. */
export function readableAuditKinds(context: WorkspaceContext): readonly AuditEventKind[] {
  scopeOf(context);
  return WORKSPACE_ADMIN_ROLES.includes(context.role)
    ? AUDIT_EVENT_KINDS
    : AUDIT_EVENT_KINDS.filter((kind) => !ADMIN_ONLY_AUDIT_KINDS.includes(kind));
}
