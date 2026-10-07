/**
 * The internal audit: what a member of staff did, and under what authority (#59, ADMIN_OPERATIONS.md).
 *
 * Separate from `audit-store.ts`, and the migration's own comment names the four reasons. The two that
 * make it impossible rather than awkward: `audit_events.workspace_id` is `NOT NULL`, so an action naming
 * no tenant has no row shape; and `searchAuditEvents` authorizes through a *customer's* context, so staff
 * activity filed there would be readable by the customer's owner.
 *
 * Three properties this file exists to hold.
 *
 * **Severity is derived, not passed.** `platformAuditSeverity` decides from the kind, and a CHECK says the
 * same thing in the database. A caller that could choose would eventually file a break-glass grant as
 * routine — in a hurry, which is exactly when break-glass happens — and the row an incident review reads
 * first would be the wrong one.
 *
 * **It is written in the caller's transaction.** Every writer takes a `DbExecutor`, so the record of an
 * action and the action itself commit together or not at all. An audit row written afterwards is a row
 * that is missing exactly when the interesting thing happened.
 *
 * **It is append-only**, by trigger. An internal audit somebody could edit is not one.
 */
import {
  PLATFORM_AUDIT_KINDS,
  platformAuditSeverity,
  type PlatformAuditKind,
  type PlatformAuditSeverity,
  type PlatformRole,
} from "@omnichannel/domain";

import type { DbExecutor } from "./client";
import { DbInputError } from "./errors";
import { platformActorOf, type PlatformContext } from "./platform-tenancy";

export interface PlatformAuditInput {
  readonly kind: PlatformAuditKind;
  /** What the action was about: a type and an id, with no foreign key. `AuditEvent`'s own shape. */
  readonly subjectType: string;
  readonly subjectId: string;
  /** Why. Required for every kind — an internal action with no stated reason is what this prevents. */
  readonly reason: string;
  readonly workspaceId?: string;
  readonly businessProfileId?: string;
  /** The session this was taken under. Required by a CHECK for a content read. */
  readonly supportSessionId?: string;
  /** Normalized detail only: never a token, a key, a signing secret or customer message text. */
  readonly detail?: Readonly<Record<string, unknown>>;
  readonly occurredAt?: Date;
}

export interface PlatformAuditRow {
  readonly id: string;
  readonly kind: PlatformAuditKind;
  readonly severity: PlatformAuditSeverity;
  readonly actorRole: PlatformRole;
  readonly actorName: string | null;
  readonly workspaceId: string | null;
  readonly businessProfileId: string | null;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly reason: string;
  readonly supportSessionId: string | null;
  readonly detail: unknown;
  readonly occurredAt: Date;
}

/**
 * Appends one internal audit row, inside the caller's transaction.
 *
 * The role recorded is the one in force now, read from the validated context rather than from the
 * `platform_members` row at read time — a role can change, and this row must not.
 */
export async function recordPlatformAuditEvent(
  db: DbExecutor,
  context: PlatformContext,
  input: PlatformAuditInput,
): Promise<{ readonly id: string }> {
  const actor = platformActorOf(context);
  if (input.reason.trim() === "") {
    throw new DbInputError("reason", "an internal action records why it was taken");
  }
  if (input.subjectType.trim() === "" || input.subjectId.trim() === "") {
    throw new DbInputError("subjectId", "an internal action records what it was about");
  }
  const created = await db.platformAuditEvent.create({
    data: {
      platformMemberId: actor.platformMemberId,
      actorRole: actor.role,
      kind: input.kind,
      // Derived, never a parameter. The CHECK on the table says the same, for the case where a support
      // script writes a row by hand and this function is not the one running.
      severity: platformAuditSeverity(input.kind),
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      ...(input.businessProfileId === undefined ? {} : { businessProfileId: input.businessProfileId }),
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      reason: input.reason.trim(),
      ...(input.supportSessionId === undefined ? {} : { supportSessionId: input.supportSessionId }),
      ...(input.detail === undefined ? {} : { detail: input.detail as never }),
      ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
    },
    select: { id: true },
  });
  return created;
}

export interface PlatformAuditSearch {
  readonly kinds?: readonly PlatformAuditKind[];
  readonly severities?: readonly PlatformAuditSeverity[];
  readonly workspaceId?: string;
  readonly platformMemberId?: string;
  readonly from?: Date;
  readonly to?: Date;
  readonly limit?: number;
  readonly cursor?: { readonly occurredAt: Date; readonly id: string };
}

export interface PlatformAuditPage {
  readonly rows: readonly PlatformAuditRow[];
  readonly nextCursor?: { readonly occurredAt: Date; readonly id: string };
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Reads the internal audit.
 *
 * No role filters *what* is shown. Every internal role that can read this log reads all of it, including
 * its own actions and including the CRITICAL rows — a log where staff cannot see each other's actions is
 * a log that protects staff rather than customers, which is backwards. What gates it is holding
 * `READ_PLATFORM_AUDIT` at all, which the caller checks.
 */
export async function searchPlatformAuditEvents(db: DbExecutor, context: PlatformContext, search: PlatformAuditSearch = {}): Promise<PlatformAuditPage> {
  platformActorOf(context);
  const limit = Math.min(Math.max(Math.trunc(search.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const rows = await db.platformAuditEvent.findMany({
    where: {
      ...(search.kinds === undefined || search.kinds.length === 0 ? {} : { kind: { in: [...search.kinds] } }),
      ...(search.severities === undefined || search.severities.length === 0 ? {} : { severity: { in: [...search.severities] } }),
      ...(search.workspaceId === undefined ? {} : { workspaceId: search.workspaceId }),
      ...(search.platformMemberId === undefined ? {} : { platformMemberId: search.platformMemberId }),
      ...(search.from === undefined && search.to === undefined
        ? {}
        : { occurredAt: { ...(search.from === undefined ? {} : { gte: search.from }), ...(search.to === undefined ? {} : { lte: search.to }) } }),
      // Keyset paging on `(occurredAt, id)`, the same shape the customer audit uses: an offset would
      // skip or repeat rows as new ones land, and new ones land while an operator is reading.
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
    take: limit + 1,
    select: {
      id: true,
      kind: true,
      severity: true,
      actorRole: true,
      workspaceId: true,
      businessProfileId: true,
      subjectType: true,
      subjectId: true,
      reason: true,
      supportSessionId: true,
      detail: true,
      occurredAt: true,
      actor: { select: { user: { select: { name: true } } } },
    },
  });
  const page = rows.slice(0, limit).map((row) => ({
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    actorRole: row.actorRole,
    actorName: row.actor.user.name,
    workspaceId: row.workspaceId,
    businessProfileId: row.businessProfileId,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    reason: row.reason,
    supportSessionId: row.supportSessionId,
    detail: row.detail,
    occurredAt: row.occurredAt,
  }));
  const last = page.at(-1);
  return {
    rows: page,
    ...(rows.length > limit && last !== undefined ? { nextCursor: { occurredAt: last.occurredAt, id: last.id } } : {}),
  };
}

/** Every kind, for a filter control that should offer what exists rather than what somebody remembered. */
export const PLATFORM_AUDIT_KIND_LIST: readonly PlatformAuditKind[] = PLATFORM_AUDIT_KINDS;
