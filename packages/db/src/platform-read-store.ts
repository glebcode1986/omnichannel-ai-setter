/**
 * What an internal operator may read, and the two things they may do (#59, ADMIN_OPERATIONS.md).
 *
 * Every function here takes a `PlatformContext` and an explicit workspace. That is the opposite of how
 * the customer stores work, and it is the right way round: an operator legitimately reads across tenants,
 * so there is no membership to narrow a query for them and the narrowing has to be written out. Every
 * query below is bounded by the workspace it was handed, and where a profile is named, by both.
 *
 * **No function here accepts a customer context, and none returns one.** `platform-boundary.test.ts`
 * asserts that no exported signature in this module takes a `WorkspaceContext` or a
 * `BusinessProfileContext` — because the moment one does, `scopeOf` stops meaning "a member authorized
 * this".
 *
 * **Metadata by default, content only under a session.** `readSupportSnapshot` never selects a message
 * body; `readConversationContent` takes a `SupportScope` and refuses unless it grants
 * `CONVERSATION_CONTENT`. Two reads rather than one with a flag, deliberately: a single read that
 * stripped the text in its mapping layer would re-leak it the first time somebody added a field to the
 * `select`.
 *
 * **Nothing here reads a credential.** Provider tokens are envelope-encrypted with the key outside the
 * database, so a console that never calls the cipher cannot show one. This module imports no credential
 * helper, and the boundary test names `readChannelCredential` and `getChannelAccountCredentialId` as
 * forbidden so that stays true.
 *
 * **Pause state comes from one place.** `loadCovering` plus the domain's `activeSuspension`, never the
 * ad-hoc queries in `followup-store.ts` (which omits the GLOBAL scope entirely) or `setup-store.ts`
 * (which ignores the time window). Those two disagree with the delivery path and are their own change;
 * a console that reused either would show a third answer to "what is paused right now".
 */
import {
  activeSuspension,
  supportScopeGrants,
  type AutomationSuspension,
  type EntitlementSnapshot,
  type LedgerMetric,
  type SupportScope,
  type SuspensionScope,
} from "@omnichannel/domain";

import type { DbExecutor } from "./client";
import { readEntitlement } from "./entitlement-store";
import { DbInputError, PlatformPermissionError } from "./errors";
import { platformActorOf, requirePlatformPermission, type PlatformContext } from "./platform-tenancy";
import { readUsageSnapshot } from "./usage-store";

/** One workspace in a lookup result: enough to recognise it, nothing a session should be needed for. */
export interface WorkspaceHit {
  readonly workspaceId: string;
  readonly name: string;
  readonly createdAt: Date;
  readonly businessProfiles: number;
  readonly members: number;
}

/**
 * Finds workspaces by id fragment or name.
 *
 * Cross-tenant by definition, which is why the lookup itself is the privilege and why the console audits
 * an inspection. Capped and ordered, because an unbounded listing of every tenant is a different feature
 * with a different conversation attached to it.
 */
export async function findWorkspaces(
  db: DbExecutor,
  context: PlatformContext,
  query: { readonly term: string; readonly limit?: number },
): Promise<readonly WorkspaceHit[]> {
  requirePlatformPermission(context, "READ_METADATA", "look up a workspace");
  const term = query.term.trim();
  if (term === "") {
    return [];
  }
  const rows = await db.workspace.findMany({
    where: { OR: [{ id: { contains: term } }, { name: { contains: term, mode: "insensitive" } }] },
    orderBy: [{ createdAt: "desc" }],
    take: Math.min(Math.max(Math.trunc(query.limit ?? 20), 1), 50),
    select: { id: true, name: true, createdAt: true, _count: { select: { businessProfiles: true, members: true } } },
  });
  return rows.map((row) => ({
    workspaceId: row.id,
    name: row.name,
    createdAt: row.createdAt,
    businessProfiles: row._count.businessProfiles,
    members: row._count.members,
  }));
}

export interface ChannelDiagnostic {
  readonly channelAccountId: string;
  readonly businessProfileId: string;
  readonly channel: string;
  readonly status: string;
  readonly displayName: string | null;
  /** The provider's own account id. Not a secret; it is what a provider's support desk asks for. */
  readonly externalAccountId: string;
  /** When the account row was created. The nearest durable thing to "connected since" that exists. */
  readonly connectedAt: Date;
}

export interface ProfileDiagnostic {
  readonly businessProfileId: string;
  readonly name: string;
  readonly status: string;
  readonly channelAccounts: number;
  /**
   * Whether this profile is on the limited-rollout autopilot allowlist (#60, §18 stage three).
   *
   * Here because an operator who can change the list has to be able to see it. Without it the flag was a
   * column nothing displayed, so "which profiles send unattended during the limited rollout" was a
   * question only a SQL prompt could answer — which is the thing this console exists to end.
   */
  readonly rolloutAutopilot: boolean;
}

/**
 * The metadata snapshot: identifiers, capability state, commercial state, timings and counts.
 *
 * No message text, no draft text, no transcript, and not by stripping them later — nothing in this
 * function selects a column that holds any. The `lastInboundAt` / `lastOutboundAt` pair is computed with
 * its own aggregate rather than borrowed from `readConversation`, which selects those timestamps in the
 * same query as `messages.text`.
 */
export interface SupportSnapshot {
  readonly workspaceId: string;
  readonly name: string;
  readonly createdAt: Date;
  readonly members: number;
  readonly profiles: readonly ProfileDiagnostic[];
  readonly channels: readonly ChannelDiagnostic[];
  readonly entitlement: EntitlementSnapshot;
  readonly usage: {
    readonly periodStartsAt: Date;
    readonly periodEndsAt: Date;
    readonly cycleOpened: boolean;
    readonly counters: Partial<Record<LedgerMetric, { readonly committed: number; readonly reserved: number }>>;
  };
  readonly lastInboundAt: Date | null;
  readonly lastOutboundAt: Date | null;
  readonly pendingReconciliations: number;
  readonly pause?: {
    readonly scope: SuspensionScope;
    readonly reason: string;
    readonly since: Date;
    readonly until: Date | null;
    readonly byOperator: boolean;
  };
}

export async function readSupportSnapshot(
  db: DbExecutor,
  context: PlatformContext,
  workspaceId: string,
  at = new Date(),
): Promise<SupportSnapshot | null> {
  requirePlatformPermission(context, "READ_METADATA", "read a support snapshot");
  const workspace = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, name: true, createdAt: true, _count: { select: { members: true } } },
  });
  if (workspace === null) {
    // Null rather than a throw, so the console can tell "no such workspace" from "something failed" —
    // `readUsageAnchorDay` uses `findUniqueOrThrow` and would have conflated the two.
    return null;
  }

  const [profiles, channels, inbound, outbound, reconciliations, usage, entitlement, pause] = await Promise.all([
    db.businessProfile.findMany({
      where: { workspaceId },
      orderBy: [{ createdAt: "asc" }],
      select: { id: true, name: true, status: true, rolloutAutopilot: true, _count: { select: { channelAccounts: true } } },
    }),
    db.channelAccount.findMany({
      where: { workspaceId },
      orderBy: [{ createdAt: "asc" }],
      // No `capabilities` and no credential reference: a provider-shaped blob on an internal screen is
      // the leak this console is most likely to introduce, and the status is the diagnostic.
      select: { id: true, businessProfileId: true, channel: true, status: true, displayName: true, externalAccountId: true, createdAt: true },
    }),
    // `IN` and `OUT` are the enum's own names; the pair answers "is anything reaching this tenant, and
    // is anything leaving it", which is the first question an operator asks about a quiet workspace.
    db.message.aggregate({ where: { workspaceId, direction: "IN" }, _max: { occurredAt: true } }),
    db.message.aggregate({ where: { workspaceId, direction: "OUT" }, _max: { occurredAt: true } }),
    db.deliveryReconciliation.count({ where: { workspaceId, state: "PENDING" } }),
    readUsageSnapshot(db, workspaceId, at),
    readEntitlementFor(db, workspaceId, at),
    readActivePause(db, workspaceId, at),
  ]);

  return {
    workspaceId: workspace.id,
    name: workspace.name,
    createdAt: workspace.createdAt,
    members: workspace._count.members,
    profiles: profiles.map((profile) => ({
      businessProfileId: profile.id,
      name: profile.name,
      status: profile.status,
      channelAccounts: profile._count.channelAccounts,
      rolloutAutopilot: profile.rolloutAutopilot,
    })),
    channels: channels.map((account) => ({
      channelAccountId: account.id,
      businessProfileId: account.businessProfileId,
      channel: account.channel,
      status: account.status,
      displayName: account.displayName,
      externalAccountId: account.externalAccountId,
      connectedAt: account.createdAt,
    })),
    entitlement,
    usage: { periodStartsAt: usage.bounds.startsAt, periodEndsAt: usage.bounds.endsAt, cycleOpened: usage.cycleOpened, counters: usage.counters },
    lastInboundAt: inbound._max?.occurredAt ?? null,
    lastOutboundAt: outbound._max?.occurredAt ?? null,
    pendingReconciliations: reconciliations,
    ...(pause === undefined ? {} : { pause }),
  };
}

/**
 * The entitlement, read through the customer path's own resolver.
 *
 * `readEntitlement` takes a bare workspace id and performs no authorization of its own — which its own
 * comment explains is for the server-side checks that have no session — so it is the right function for
 * this and the authorization is the `requirePlatformPermission` above.
 */
async function readEntitlementFor(db: DbExecutor, workspaceId: string, at: Date): Promise<EntitlementSnapshot> {
  // `readEntitlement` is typed against the client rather than an executor; it only reads, so widening
  // the parameter here would be a change to that file. Cast is confined to this one line and commented.
  return readEntitlement(db as Parameters<typeof readEntitlement>[0], workspaceId, at);
}

/**
 * What is pausing automated outbound for this workspace, if anything.
 *
 * Loads every unlifted suspension whose scope could cover the workspace and lets the domain decide which
 * one wins, exactly as the delivery claim does. A narrower switch on one profile or one channel account
 * is reported too, because an operator asking "why is nothing going out?" needs the narrow answer as much
 * as the wide one.
 */
async function readActivePause(db: DbExecutor, workspaceId: string, at: Date): Promise<SupportSnapshot["pause"]> {
  const rows = await db.automationSuspension.findMany({
    where: { liftedAt: null, OR: [{ scope: "GLOBAL" }, { workspaceId }] },
    select: { scope: true, workspaceId: true, businessProfileId: true, channelAccountId: true, reason: true, note: true, since: true, until: true, byUserId: true },
  });
  const suspensions = rows.map(
    (row) =>
      ({
        scope: row.scope,
        ...(row.workspaceId === null ? {} : { workspaceId: row.workspaceId }),
        ...(row.businessProfileId === null ? {} : { businessProfileId: row.businessProfileId }),
        ...(row.channelAccountId === null ? {} : { channelAccountId: row.channelAccountId }),
        reason: row.reason,
        ...(row.note === null ? {} : { note: row.note }),
        since: row.since,
        ...(row.until === null ? {} : { until: row.until }),
        ...(row.byUserId === null ? {} : { byUserId: row.byUserId }),
      }) as AutomationSuspension,
  );
  // The target has to name a profile and a channel account for the domain's `covers` to judge the narrow
  // scopes. Any one of the workspace's own will do for "is this workspace paused at all", and the widest
  // match wins regardless, so a sentinel would only ever miss a narrow switch — hence the real ids.
  for (const candidate of await db.channelAccount.findMany({ where: { workspaceId }, select: { id: true, businessProfileId: true }, take: 50 })) {
    const active = activeSuspension(
      { workspaceId, businessProfileId: candidate.businessProfileId, channelAccountId: candidate.id } as never,
      suspensions,
      at,
    );
    if (active !== undefined) {
      return { scope: active.scope, reason: active.reason, since: active.since, until: active.until ?? null, byOperator: active.byUserId !== undefined };
    }
  }
  // No channel account to judge against: only the wide scopes can apply.
  const wide = suspensions.find(
    (suspension) =>
      (suspension.scope === "GLOBAL" || (suspension.scope === "WORKSPACE" && suspension.workspaceId === workspaceId)) &&
      suspension.since.getTime() <= at.getTime() &&
      (suspension.until === undefined || suspension.until.getTime() > at.getTime()),
  );
  return wide === undefined
    ? undefined
    : { scope: wide.scope, reason: wide.reason, since: wide.since, until: wide.until ?? null, byOperator: wide.byUserId !== undefined };
}

export interface ConversationContentLine {
  readonly messageId: string;
  readonly direction: string;
  readonly kind: string;
  readonly occurredAt: Date;
  readonly text: string | null;
}

/**
 * A customer's correspondence, under a session that granted it.
 *
 * The only read in this module that returns content, and the only one that takes a `SupportScope`. The
 * refusal is a throw rather than an empty list, because "there is nothing here" and "you may not see
 * what is here" are different facts and a screen that could not tell them apart would send an operator
 * to open a session they already have.
 *
 * The caller records `CUSTOMER_CONTENT_READ` — a CRITICAL audit row whose CHECK requires the session id,
 * so a content read with no session named cannot be filed at all.
 */
export async function readConversationContent(
  db: DbExecutor,
  context: PlatformContext,
  scope: SupportScope,
  target: { readonly workspaceId: string; readonly businessProfileId: string; readonly conversationId: string; readonly limit?: number },
): Promise<readonly ConversationContentLine[]> {
  platformActorOf(context);
  if (!supportScopeGrants(scope, "CONVERSATION_CONTENT")) {
    throw new PlatformPermissionError(
      platformActorOf(context).role,
      "OPEN_SUPPORT_SESSION",
      `read a customer's correspondence (${scope.refusal ?? "NOT_GRANTED"})`,
    );
  }
  // The scope's own target has to be the one being read. A live session for workspace A must not read
  // workspace B, and a profile-scoped session must not read a sibling profile.
  if (scope.workspaceId !== target.workspaceId) {
    throw new DbInputError("workspaceId", "the session in force is for another workspace");
  }
  if (scope.businessProfileId !== undefined && scope.businessProfileId !== target.businessProfileId) {
    throw new DbInputError("businessProfileId", "the session in force is for another Business Profile");
  }

  const rows = await db.message.findMany({
    where: { workspaceId: target.workspaceId, businessProfileId: target.businessProfileId, conversationId: target.conversationId },
    orderBy: [{ occurredAt: "desc" }],
    take: Math.min(Math.max(Math.trunc(target.limit ?? 50), 1), 200),
    select: { id: true, direction: true, kind: true, occurredAt: true, text: true },
  });
  return rows.map((row) => ({ messageId: row.id, direction: row.direction, kind: row.kind, occurredAt: row.occurredAt, text: row.text }));
}

export interface ReconciliationRow {
  readonly operationId: string;
  readonly workspaceId: string;
  readonly businessProfileId: string;
  readonly conversationId: string;
  readonly reason: string;
  readonly state: string;
  readonly attemptCount: number;
  readonly detectedAt: Date;
  readonly lastAttemptAt: Date | null;
  readonly resolvedAt: Date | null;
  /** One short phrase. Never a provider response body, never a secret — the column's own contract. */
  readonly evidence: string | null;
  readonly providerRequestId: string | null;
  readonly providerCode: string | null;
  readonly correlationId: string | null;
}

/**
 * The ambiguous operations an operator has to decide about.
 *
 * A new read rather than `findUnresolvedOperations`, which is written for the sweeper: it filters on a
 * retry deadline, merges in orphaned held deliveries and returns neither the state, the evidence nor the
 * attempt count — the three things a person looking at a list needs. This one filters by state and by
 * workspace, newest first, and carries the correlation id so an operator can follow the operation.
 */
export async function listReconciliations(
  db: DbExecutor,
  context: PlatformContext,
  query: { readonly workspaceId?: string; readonly states?: readonly string[]; readonly limit?: number },
): Promise<readonly ReconciliationRow[]> {
  requirePlatformPermission(context, "READ_METADATA", "list ambiguous operations");
  const rows = await db.deliveryReconciliation.findMany({
    where: {
      ...(query.workspaceId === undefined ? {} : { workspaceId: query.workspaceId }),
      ...(query.states === undefined || query.states.length === 0 ? { state: { in: ["PENDING", "NEEDS_HUMAN"] } } : { state: { in: query.states as never } }),
    },
    orderBy: [{ detectedAt: "desc" }],
    take: Math.min(Math.max(Math.trunc(query.limit ?? 50), 1), 200),
    select: {
      operationId: true,
      workspaceId: true,
      businessProfileId: true,
      conversationId: true,
      reason: true,
      state: true,
      attemptCount: true,
      detectedAt: true,
      lastAttemptAt: true,
      resolvedAt: true,
      evidence: true,
      providerRequestId: true,
      providerCode: true,
      deliveryJob: { select: { correlationId: true } },
    },
  });
  return rows.map((row) => ({
    operationId: row.operationId,
    workspaceId: row.workspaceId,
    businessProfileId: row.businessProfileId,
    conversationId: row.conversationId,
    reason: row.reason,
    state: row.state,
    attemptCount: row.attemptCount,
    detectedAt: row.detectedAt,
    lastAttemptAt: row.lastAttemptAt,
    resolvedAt: row.resolvedAt,
    evidence: row.evidence,
    providerRequestId: row.providerRequestId,
    providerCode: row.providerCode,
    correlationId: row.deliveryJob.correlationId,
  }));
}
