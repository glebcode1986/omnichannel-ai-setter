/**
 * Granting, revoking and deriving scoped access to one customer's data (#59, ADMIN_OPERATIONS.md).
 *
 * Metadata needs no session. An operator looking a workspace up sees identifiers, capability state,
 * commercial state and operational health without asking anybody — that is the diagnostic floor, and
 * requiring a session for it would mean a session for every page load, which trains people to open them
 * reflexively and empties the record of meaning.
 *
 * This is for the step beyond that: reading somebody's correspondence. Explicit, scoped, time-bounded,
 * audited — the spec's four words, and each one is a mechanism here rather than a promise.
 *
 * **Expiry is derived at every read.** `readSupportScope` loads the newest live session and hands it to
 * the domain's `supportScopeOf` with a clock. Nothing sweeps, nothing marks a row expired, and there is
 * therefore no window in which a lapsed session still reads as live because nobody re-read it. The
 * trade-off is the one `tenancy.ts` makes for membership and states in its own header: the answer is
 * re-derived per request, so a revocation landing mid-request is not seen by that request. Re-derive per
 * server action, not once per page render.
 *
 * **Renewal is visible rather than capped.** Nothing here stops an operator opening a fresh break-glass
 * session the moment the last lapses — a continuous chain of fifteen-minute grants is operationally
 * identical to standing access. Whether a hard cap exists, and what it is, is policy the product owner
 * has not set; what this does is count the actor's recent break-glass sessions for the same workspace and
 * put that count in the audit row, so a chain reads as a chain instead of as diligence.
 */
import {
  supportScopeOf,
  validateSupportSessionRequest,
  BREAK_GLASS_MAX_MS,
  SUPPORT_SESSION_MAX_MS,
  isSupportDataScope,
  noSupportScope,
  type PlatformRole,
  type SupportAccessSession,
  type SupportDataScope,
  type SupportScope,
} from "@omnichannel/domain";

import type { DbClient, DbExecutor } from "./client";
import { DbInputError } from "./errors";
import { recordPlatformAuditEvent } from "./platform-audit-store";
import { platformActorOf, requirePlatformPermission, type PlatformContext } from "./platform-tenancy";

/**
 * How many recent sessions are considered when deriving a scope.
 *
 * More than one, because the newest session may be revoked while an older one is still live; a handful,
 * because an operator with dozens of sessions for one workspace in flight is not a case worth optimising
 * and the newest few are the ones that can still grant anything.
 */
const CANDIDATE_SESSIONS = 5;

/** How far back a break-glass chain is counted, for the audit row's own context. */
const BREAK_GLASS_CHAIN_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface OpenSupportSessionInput {
  readonly workspaceId: string;
  /** Scoping to one profile is narrower and should be preferred; absent means the whole workspace. */
  readonly businessProfileId?: string;
  readonly scopes: readonly SupportDataScope[];
  readonly reason: string;
  readonly ticketRef?: string;
  readonly breakGlass?: boolean;
  /** How long it should last. Clamped by the domain's ceilings and by a CHECK. */
  readonly durationMs?: number;
  readonly at?: Date;
}

export interface OpenedSupportSession {
  readonly sessionId: string;
  readonly expiresAt: Date;
  readonly breakGlass: boolean;
  /** How many break-glass sessions this actor has opened for this workspace in the last day, this one included. */
  readonly breakGlassInWindow: number;
}

/**
 * Opens a session, writes its audit row in the same transaction, and refuses everything else.
 *
 * Break-glass is a separate permission from an ordinary session, which is the issue's one explicit rule
 * applied twice: support metadata does not carry conversation content, and an ordinary session does not
 * carry the right to grant yourself one without waiting.
 */
export async function openSupportAccessSession(db: DbClient, context: PlatformContext, input: OpenSupportSessionInput): Promise<OpenedSupportSession> {
  const breakGlass = input.breakGlass === true;
  requirePlatformPermission(
    context,
    breakGlass ? "BREAK_GLASS" : "OPEN_SUPPORT_SESSION",
    breakGlass ? "break the glass" : "open a support access session",
  );
  const actor = platformActorOf(context);
  const at = input.at ?? new Date();
  const scopes = input.scopes.filter(isSupportDataScope);
  if (scopes.length !== input.scopes.length) {
    throw new DbInputError("scopes", "not every requested scope is a support data scope");
  }
  const ceiling = breakGlass ? BREAK_GLASS_MAX_MS : SUPPORT_SESSION_MAX_MS;
  const expiresAt = new Date(at.getTime() + Math.min(input.durationMs ?? ceiling, ceiling));
  // Validated in the domain before anything is written, so a request for a nine-hour break-glass session
  // comes back as a sentence rather than as a constraint violation.
  validateSupportSessionRequest({ scopes, reason: input.reason, breakGlass, startedAt: at, expiresAt });

  return db.$transaction(async (tx) => {
    // The profile, checked against the workspace. The composite foreign key would refuse a mismatch
    // anyway; this makes it a sentence, and it is also how "no such profile" and "another tenant's
    // profile" come to fail identically.
    if (input.businessProfileId !== undefined) {
      const profile = await tx.businessProfile.findUnique({
        where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.businessProfileId } },
        select: { id: true },
      });
      if (profile === null) {
        throw new DbInputError("businessProfileId", "no such Business Profile in that workspace");
      }
    }
    const breakGlassInWindow = breakGlass
      ? (await tx.supportAccessSession.count({
          where: {
            platformMemberId: actor.platformMemberId,
            workspaceId: input.workspaceId,
            breakGlass: true,
            startedAt: { gte: new Date(at.getTime() - BREAK_GLASS_CHAIN_WINDOW_MS) },
          },
        })) + 1
      : 0;

    const session = await tx.supportAccessSession.create({
      data: {
        platformMemberId: actor.platformMemberId,
        actorRole: actor.role,
        workspaceId: input.workspaceId,
        ...(input.businessProfileId === undefined ? {} : { businessProfileId: input.businessProfileId }),
        scopes: [...scopes],
        reason: input.reason.trim(),
        ...(input.ticketRef === undefined ? {} : { ticketRef: input.ticketRef }),
        breakGlass,
        startedAt: at,
        expiresAt,
      },
      select: { id: true },
    });

    await recordPlatformAuditEvent(tx, context, {
      kind: breakGlass ? "BREAK_GLASS_OPENED" : "SUPPORT_SESSION_OPENED",
      subjectType: "SupportAccessSession",
      subjectId: session.id,
      reason: input.reason,
      workspaceId: input.workspaceId,
      ...(input.businessProfileId === undefined ? {} : { businessProfileId: input.businessProfileId }),
      supportSessionId: session.id,
      detail: {
        scopes: [...scopes],
        expiresAt: expiresAt.toISOString(),
        ...(input.ticketRef === undefined ? {} : { ticketRef: input.ticketRef }),
        // A chain of short grants is operationally standing access. Counted here so that the log shows
        // it as one thing rather than as several unrelated careful decisions.
        ...(breakGlass ? { breakGlassInWindow } : {}),
      },
    });
    return { sessionId: session.id, expiresAt, breakGlass, breakGlassInWindow };
  });
}

/**
 * Ends a session now.
 *
 * `revokedAt: null` in the predicate, so a second click does not rewrite who revoked it first — the same
 * guard `lift` uses on a kill switch, for the same reason.
 */
export async function revokeSupportAccessSession(
  db: DbClient,
  context: PlatformContext,
  input: { readonly sessionId: string; readonly reason: string; readonly at?: Date },
): Promise<{ readonly revoked: boolean }> {
  requirePlatformPermission(context, "OPEN_SUPPORT_SESSION", "revoke a support access session");
  const actor = platformActorOf(context);
  const at = input.at ?? new Date();

  return db.$transaction(async (tx) => {
    const session = await tx.supportAccessSession.findUnique({
      where: { id: input.sessionId },
      select: { workspaceId: true, businessProfileId: true, revokedAt: true },
    });
    if (session === null) {
      throw new DbInputError("sessionId", "no such support access session");
    }
    if (session.revokedAt !== null) {
      return { revoked: false };
    }
    // The count decides, not the read above — the same correction as `liftKillSwitch`. Two operators can
    // both see an unrevoked session and both call this; the predicate lets exactly one change the row, and
    // ignoring the count made the loser claim a revocation it did not perform.
    const { count } = await tx.supportAccessSession.updateMany({
      where: { id: input.sessionId, revokedAt: null },
      data: { revokedAt: at, revokedByMemberId: actor.platformMemberId },
    });
    if (count === 0) {
      // Already revoked by the time this write landed. No transition, so no transition event.
      return { revoked: false };
    }
    await recordPlatformAuditEvent(tx, context, {
      kind: "SUPPORT_SESSION_REVOKED",
      subjectType: "SupportAccessSession",
      subjectId: input.sessionId,
      reason: input.reason,
      workspaceId: session.workspaceId,
      ...(session.businessProfileId === null ? {} : { businessProfileId: session.businessProfileId }),
      supportSessionId: input.sessionId,
      occurredAt: at,
    });
    return { revoked: true };
  });
}

/**
 * What this operator may read for this target, right now.
 *
 * Takes the newest session that could cover the target and lets the domain judge it. "Newest" rather than
 * "any live one" because an operator who opened a narrower or wider session most recently meant the one
 * they just opened; and `supportScopeOf` refuses it anyway if it does not cover the target, so a wrong
 * guess here produces a refusal rather than an over-grant.
 */
export async function readSupportScope(
  db: DbExecutor,
  context: PlatformContext,
  target: { readonly workspaceId: string; readonly businessProfileId?: string },
  at = new Date(),
): Promise<SupportScope> {
  const actor = platformActorOf(context);
  const rows = await db.supportAccessSession.findMany({
    where: {
      platformMemberId: actor.platformMemberId,
      workspaceId: target.workspaceId,
      // Either a workspace-wide session, or one for exactly this profile. A session for *another*
      // profile is excluded here, and `supportScopeOf` would refuse it as `OUT_OF_SCOPE` anyway.
      ...(target.businessProfileId === undefined
        ? { businessProfileId: null }
        : { OR: [{ businessProfileId: null }, { businessProfileId: target.businessProfileId }] }),
    },
    // Deliberately *not* filtered by the clock or by revocation. Filtering here would make the query the
    // thing that decides, and an operator whose session ran out five minutes ago would be told there was
    // never a session at all — which sends them to open a second one instead of renewing. The domain
    // judges, and the refusal it returns says which of the four things went wrong.
    orderBy: [{ startedAt: "desc" }],
    take: CANDIDATE_SESSIONS,
    select: { id: true, workspaceId: true, businessProfileId: true, scopes: true, breakGlass: true, startedAt: true, expiresAt: true, revokedAt: true },
  });
  if (rows.length === 0) {
    return noSupportScope(target.workspaceId, "NO_SESSION", target.businessProfileId);
  }
  const scopes = rows.map((row) =>
    supportScopeOf(
      {
        sessionId: row.id,
        workspaceId: row.workspaceId,
        ...(row.businessProfileId === null ? {} : { businessProfileId: row.businessProfileId }),
        scopes: row.scopes.filter(isSupportDataScope),
        breakGlass: row.breakGlass,
        startedAt: row.startedAt,
        expiresAt: row.expiresAt,
        ...(row.revokedAt === null ? {} : { revokedAt: row.revokedAt }),
      } satisfies SupportAccessSession,
      target,
      at,
    ),
  );
  // The first session that actually grants something wins, so a revoked newest session does not hide a
  // live older one. When none grants, the newest one's refusal is reported: it describes the attempt the
  // operator most recently made, which is the one they are asking about.
  return scopes.find((scope) => scope.granted.length > 0) ?? scopes[0] ?? noSupportScope(target.workspaceId, "NO_SESSION", target.businessProfileId);
}

export interface SupportSessionRow {
  readonly sessionId: string;
  readonly actorName: string | null;
  readonly actorRole: string;
  readonly businessProfileId: string | null;
  readonly scopes: readonly string[];
  readonly reason: string;
  readonly ticketRef: string | null;
  readonly breakGlass: boolean;
  readonly startedAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  /** Computed, not stored: a live session is one whose clock has not run out and which nobody revoked. */
  readonly live: boolean;
}

/** Every session that touched this workspace, newest first, so an operator can see who has been in it. */
export async function listSupportSessions(
  db: DbExecutor,
  context: PlatformContext,
  workspaceId: string,
  at = new Date(),
  limit = 25,
): Promise<readonly SupportSessionRow[]> {
  platformActorOf(context);
  const rows = await db.supportAccessSession.findMany({
    where: { workspaceId },
    orderBy: [{ startedAt: "desc" }],
    take: Math.min(Math.max(Math.trunc(limit), 1), 100),
    select: {
      id: true,
      actorRole: true,
      businessProfileId: true,
      scopes: true,
      reason: true,
      ticketRef: true,
      breakGlass: true,
      startedAt: true,
      expiresAt: true,
      revokedAt: true,
      actor: { select: { user: { select: { name: true } } } },
    },
  });
  return rows.map((row) => ({
    sessionId: row.id,
    actorName: row.actor.user.name,
    actorRole: row.actorRole,
    businessProfileId: row.businessProfileId,
    scopes: row.scopes,
    reason: row.reason,
    ticketRef: row.ticketRef,
    breakGlass: row.breakGlass,
    startedAt: row.startedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    live: row.revokedAt === null && row.expiresAt.getTime() > at.getTime() && row.startedAt.getTime() <= at.getTime(),
  }));
}

/**
 * Grants or withdraws a platform role.
 *
 * `MANAGE_PLATFORM_MEMBERS` only, which `PLATFORM_ADMIN` alone holds. Deliberately *not* held by the role
 * that can change billing: the person who grants roles and the person who moves money being the same
 * person is the control this whole separation exists to provide.
 */
export async function setPlatformMember(
  db: DbClient,
  context: PlatformContext,
  input: { readonly userId: string; readonly role: PlatformRole; readonly note: string; readonly revoke?: boolean; readonly at?: Date },
): Promise<{ readonly platformMemberId: string }> {
  requirePlatformPermission(context, "MANAGE_PLATFORM_MEMBERS", "grant or withdraw a platform role");
  const at = input.at ?? new Date();
  if (input.note.trim() === "") {
    throw new DbInputError("note", "a role nobody can explain is a role nobody dares remove");
  }

  return db.$transaction(async (tx) => {
    const data = {
      role: input.role,
      note: input.note.trim(),
      revokedAt: input.revoke === true ? at : null,
    };
    const member = await tx.platformMember.upsert({
      where: { userId: input.userId },
      // `createdAt` comes from the same instant as the revocation, rather than from the column default,
      // so a row written with an explicit `at` is consistent with itself: `platform_members_shape_check`
      // requires a revocation not to precede the creation, and a caller that grants and withdraws at one
      // stated instant must not be refused because the database clock moved in between. The update branch
      // leaves `createdAt` alone — when the role was first granted is not something a later change edits.
      create: { userId: input.userId, createdAt: at, ...data },
      update: data,
      select: { id: true },
    });
    await recordPlatformAuditEvent(tx, context, {
      kind: "PLATFORM_MEMBER_CHANGED",
      subjectType: "PlatformMember",
      subjectId: member.id,
      reason: input.note,
      detail: { role: input.role, revoked: input.revoke === true },
      occurredAt: at,
    });
    return { platformMemberId: member.id };
  });
}

