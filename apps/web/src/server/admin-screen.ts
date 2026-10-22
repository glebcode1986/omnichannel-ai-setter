/**
 * What the internal console shows, assembled where a test can drive it (#59, ADMIN_OPERATIONS.md).
 *
 * Free of the authenticated request path, exactly like `billing-screen.ts`: `admin-page.ts` adds the
 * authorization and the translator and cannot be imported under Vitest.
 *
 * Three properties this file holds.
 *
 * **Metadata by default.** Every read here is metadata. A customer's own words appear on exactly one
 * screen, through `readConversationContent`, and only when a support session granted
 * `CONVERSATION_CONTENT` — which `assembleAdminConversation` reports rather than silently omitting, so an
 * operator is told their session does not cover this instead of being shown an empty thread.
 *
 * **The role decides what is offered, never what is permitted.** `can` below is for drawing the page; the
 * store refuses an operator whatever this says.
 *
 * **Pause state comes from the snapshot**, which reads it through `loadCovering` and the domain's
 * `activeSuspension` — not through the ad-hoc queries in `followup-store.ts` and `setup-store.ts`, which
 * disagree with the delivery path about what is paused.
 */
import {
  DbInputError,
  findWorkspaces,
  listKillSwitches,
  listReconciliations,
  listSupportSessions,
  platformCan,
  PlatformPermissionError,
  readConversationContent,
  readSupportScope,
  readSupportSnapshot,
  searchPlatformAuditEvents,
  type ConversationContentLine,
  type DbClient,
  type KillSwitchRow,
  type PlatformAuditRow,
  type PlatformContext,
  type ReconciliationRow,
  type SupportSessionRow,
  type SupportSnapshot,
  type WorkspaceHit,
} from "@omnichannel/db";
import { PLATFORM_PERMISSIONS, type PlatformPermission, type PlatformRole, type SupportScope } from "@omnichannel/domain";

import type { RawSearchParams } from "@/server/inbox-view";
import { one } from "@/server/style-view";

/** What this operator may be offered, as a lookup the panes read. Never a gate. */
export type PlatformCapabilities = Readonly<Record<PlatformPermission, boolean>>;

function capabilitiesOf(context: PlatformContext): PlatformCapabilities {
  return Object.fromEntries(PLATFORM_PERMISSIONS.map((permission) => [permission, platformCan(context, permission)])) as PlatformCapabilities;
}

export interface AdminHomeData {
  readonly role: PlatformRole;
  readonly can: PlatformCapabilities;
  readonly term: string;
  readonly hits: readonly WorkspaceHit[];
  /** Everything an operator has paused, platform-wide, so an incident is visible from the front page. */
  readonly killSwitches: readonly KillSwitchRow[];
  /** Ambiguous operations across every tenant: the queue this console exists to replace SQL for. */
  readonly reconciliations: readonly ReconciliationRow[];
  readonly basePath: string;
}

export async function assembleAdminHome(
  db: DbClient,
  context: PlatformContext,
  searchParams: RawSearchParams,
  basePath: string,
  at = new Date(),
): Promise<AdminHomeData> {
  const can = capabilitiesOf(context);
  const term = one(searchParams["q"]) ?? "";
  const [hits, killSwitches, reconciliations] = await Promise.all([
    term.trim() === "" ? Promise.resolve([] as readonly WorkspaceHit[]) : findWorkspaces(db, context, { term }),
    listKillSwitches(db, context, { at }),
    listReconciliations(db, context, { limit: 20 }),
  ]);
  return { role: contextRole(context), can, term, hits, killSwitches, reconciliations, basePath };
}

export interface AdminWorkspaceData {
  readonly role: PlatformRole;
  readonly can: PlatformCapabilities;
  readonly workspaceId: string;
  /** Absent when there is no such workspace, which is a different answer from "something failed". */
  readonly snapshot?: SupportSnapshot;
  readonly sessions: readonly SupportSessionRow[];
  readonly killSwitches: readonly KillSwitchRow[];
  readonly reconciliations: readonly ReconciliationRow[];
  /** What the operator's own session grants here, right now. Derived, never stored. */
  readonly scope: SupportScope;
  readonly basePath: string;
}

export async function assembleAdminWorkspace(
  db: DbClient,
  context: PlatformContext,
  workspaceId: string,
  basePath: string,
  at = new Date(),
): Promise<AdminWorkspaceData> {
  const can = capabilitiesOf(context);
  const [snapshot, sessions, killSwitches, reconciliations, scope] = await Promise.all([
    readSupportSnapshot(db, context, workspaceId, at),
    listSupportSessions(db, context, workspaceId, at),
    listKillSwitches(db, context, { workspaceId, at }),
    listReconciliations(db, context, { workspaceId, limit: 20 }),
    readSupportScope(db, context, { workspaceId }, at),
  ]);
  return {
    role: contextRole(context),
    can,
    workspaceId,
    ...(snapshot === null ? {} : { snapshot }),
    sessions,
    killSwitches,
    reconciliations,
    scope,
    basePath,
  };
}

export interface AdminConversationData {
  readonly role: PlatformRole;
  readonly can: PlatformCapabilities;
  readonly workspaceId: string;
  readonly businessProfileId: string;
  readonly conversationId: string;
  readonly scope: SupportScope;
  /** Present only when the session in force granted conversation content. */
  readonly lines?: readonly ConversationContentLine[];
  /** Why the lines are absent, in the domain's own vocabulary, so the screen can say which. */
  readonly refusal?: string;
  readonly basePath: string;
}

/**
 * The one content-bearing screen, and the only place a `SupportScope` is consumed.
 *
 * Without this the scope, the data scopes, the expiry arithmetic and the break-glass path would all be
 * types nothing reads — the "exported, tested, never called" shape this codebase has shipped before. With
 * it, the metadata default is real: the same page renders with the thread or with a sentence saying what
 * would unlock it, and the refusal is the reason rather than a blank.
 *
 * The read is attempted rather than pre-checked against `scope.granted`, so the store's refusal is what
 * decides. A screen that decided for itself would be a second opinion that could disagree.
 */
export async function assembleAdminConversation(
  db: DbClient,
  context: PlatformContext,
  target: { readonly workspaceId: string; readonly businessProfileId: string; readonly conversationId: string },
  basePath: string,
  at = new Date(),
): Promise<AdminConversationData> {
  const can = capabilitiesOf(context);
  const scope = await readSupportScope(db, context, { workspaceId: target.workspaceId, businessProfileId: target.businessProfileId }, at);
  const frame = { role: contextRole(context), can, ...target, scope, basePath } as const;
  try {
    const lines = await readConversationContent(db, context, scope, target, at);
    return { ...frame, lines };
  } catch (error) {
    if (!(error instanceof PlatformPermissionError) && !(error instanceof DbInputError)) {
      // Not a refusal. The content read now writes its `CUSTOMER_CONTENT_READ` row in the same
      // transaction that selects the messages, so a failure to record the access withholds the content
      // by rolling it back — and this catch must not then relabel a storage failure as "NOT_GRANTED",
      // which would send an operator to open a session they already hold.
      throw error;
    }
    // Any genuine refusal — no session, expired, revoked, out of scope, or a scope pointed at another
    // tenant — renders the same way: no content, and the reason the domain gave.
    return { ...frame, refusal: scope.refusal ?? "NOT_GRANTED" };
  }
}

export interface AdminAuditData {
  readonly role: PlatformRole;
  readonly can: PlatformCapabilities;
  readonly rows: readonly PlatformAuditRow[];
  readonly nextCursor?: { readonly occurredAt: Date; readonly id: string };
  readonly workspaceId?: string;
  readonly basePath: string;
}

export async function assembleAdminAudit(
  db: DbClient,
  context: PlatformContext,
  searchParams: RawSearchParams,
  basePath: string,
): Promise<AdminAuditData> {
  const workspaceId = one(searchParams["workspace"]);
  const cursorAt = one(searchParams["since"]);
  const cursorId = one(searchParams["after"]);
  const page = await searchPlatformAuditEvents(db, context, {
    ...(workspaceId === undefined ? {} : { workspaceId }),
    // Both halves or neither: a keyset cursor is a pair, and half of one would page from an instant with
    // no tiebreak, which silently repeats or skips rows.
    ...(cursorAt === undefined || cursorId === undefined || Number.isNaN(Date.parse(cursorAt))
      ? {}
      : { cursor: { occurredAt: new Date(cursorAt), id: cursorId } }),
    limit: 50,
  });
  return {
    role: contextRole(context),
    can: capabilitiesOf(context),
    rows: page.rows,
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    basePath,
  };
}

/** The role, read through the validated context rather than off the object. */
function contextRole(context: PlatformContext): PlatformRole {
  return context.role;
}
