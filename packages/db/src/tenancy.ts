/**
 * Explicit Workspace and Business Profile authorization (ADR-009, DATA_MODEL.md v0.4, TEAM_ROLES_UX.md).
 * Browser/session identity says who the user is; it never implies a Workspace or Business Profile. The role
 * answers **what** a member may do, Business Profile scope answers **where**.
 *
 * Contexts are issued per request by the functions below after reading membership, role and grants from the
 * database, so a revoked grant, role or membership is authoritative for the next request. Structurally
 * identical objects built elsewhere are rejected.
 */
import {
  hasBusinessProfileAccess,
  isValidIdentifier,
  toBusinessProfileId,
  toUserId,
  toWorkspaceId,
  toWorkspaceMemberId,
  type BusinessProfileId,
  type UserId,
  type WorkspaceId,
  type WorkspaceMemberId,
  type WorkspaceRole,
} from "@omnichannel/domain";

import type { DbExecutor } from "./client";
import { BusinessProfileAccessDeniedError, WorkspaceAccessDeniedError, WorkspacePermissionError } from "./errors";

declare const workspaceContextBrand: unique symbol;
declare const businessProfileContextBrand: unique symbol;

/** Business Profiles a member may act in, as read at authorization time. */
export type BusinessProfileScope =
  | { readonly kind: "ALL" }
  | { readonly kind: "SELECTED"; readonly businessProfileIds: readonly BusinessProfileId[] };

interface MemberFields {
  readonly workspaceId: WorkspaceId;
  readonly userId: UserId;
  readonly workspaceMemberId: WorkspaceMemberId;
  readonly role: WorkspaceRole;
}

/** Workspace-level context: membership management, Business Profile listing/creation. */
export interface WorkspaceContext extends MemberFields {
  readonly businessProfileScope: BusinessProfileScope;
  readonly [workspaceContextBrand]: true;
}

/** Context for one explicitly named Business Profile the member may act in. Required for customer data. */
export interface BusinessProfileContext extends MemberFields {
  readonly businessProfileId: BusinessProfileId;
  readonly [businessProfileContextBrand]: true;
}

export interface WorkspaceAccessRequest {
  /** Authenticated user from the Auth.js session. */
  readonly userId: string;
  /** Workspace explicitly selected by the request (route/header), never guessed. */
  readonly workspaceId: string;
}

export interface BusinessProfileAccessRequest extends WorkspaceAccessRequest {
  /** Business Profile explicitly selected by the request, never defaulted to a "first" profile. */
  readonly businessProfileId: string;
}

const issuedWorkspaceContexts = new WeakSet<object>();
const issuedBusinessProfileContexts = new WeakSet<object>();

async function loadMembership(db: DbExecutor, request: WorkspaceAccessRequest) {
  if (!isValidIdentifier(request.userId) || !isValidIdentifier(request.workspaceId)) {
    return null;
  }
  return db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: request.workspaceId, userId: request.userId } },
    select: {
      id: true,
      role: true,
      businessProfileScope: true,
      businessProfileAccess: { select: { businessProfileId: true } },
    },
  });
}

export async function authorizeWorkspaceAccess(db: DbExecutor, request: WorkspaceAccessRequest): Promise<WorkspaceContext> {
  const membership = await loadMembership(db, request);
  if (membership === null) {
    throw new WorkspaceAccessDeniedError();
  }
  const scope: BusinessProfileScope =
    membership.role === "OWNER" || membership.businessProfileScope === "ALL"
      ? { kind: "ALL" }
      : {
          kind: "SELECTED",
          businessProfileIds: Object.freeze(membership.businessProfileAccess.map((grant) => toBusinessProfileId(grant.businessProfileId))),
        };
  const context = Object.freeze({
    workspaceId: toWorkspaceId(request.workspaceId),
    userId: toUserId(request.userId),
    workspaceMemberId: toWorkspaceMemberId(membership.id),
    role: membership.role,
    businessProfileScope: Object.freeze(scope),
  }) as WorkspaceContext;
  issuedWorkspaceContexts.add(context);
  return context;
}

/**
 * Authorizes one Business Profile for this request. A profile that does not exist in the Workspace and a
 * profile the member may not access fail identically, so unauthorized profiles are not discoverable.
 */
export async function authorizeBusinessProfileAccess(
  db: DbExecutor,
  request: BusinessProfileAccessRequest,
): Promise<BusinessProfileContext> {
  const membership = await loadMembership(db, request);
  if (membership === null) {
    throw new WorkspaceAccessDeniedError();
  }
  if (!isValidIdentifier(request.businessProfileId)) {
    throw new BusinessProfileAccessDeniedError();
  }
  const businessProfileId = toBusinessProfileId(request.businessProfileId);
  const granted = hasBusinessProfileAccess(
    {
      role: membership.role,
      businessProfileScope: membership.businessProfileScope,
      grantedBusinessProfileIds: membership.businessProfileAccess.map((grant) => toBusinessProfileId(grant.businessProfileId)),
    },
    businessProfileId,
  );
  const profile = granted
    ? await db.businessProfile.findUnique({
        where: { workspaceId_id: { workspaceId: request.workspaceId, id: businessProfileId } },
        select: { id: true },
      })
    : null;
  if (profile === null) {
    throw new BusinessProfileAccessDeniedError();
  }

  const context = Object.freeze({
    workspaceId: toWorkspaceId(request.workspaceId),
    userId: toUserId(request.userId),
    workspaceMemberId: toWorkspaceMemberId(membership.id),
    role: membership.role,
    businessProfileId,
  }) as BusinessProfileContext;
  issuedBusinessProfileContexts.add(context);
  return context;
}

/** Workspace to scope queries by, rejecting contexts that did not come from authorization. */
export function scopeOf(context: WorkspaceContext): WorkspaceId {
  if (typeof context !== "object" || context === null || !issuedWorkspaceContexts.has(context)) {
    throw new WorkspaceAccessDeniedError();
  }
  return context.workspaceId;
}

/** Workspace + Business Profile to scope customer-data queries by. */
export function profileScopeOf(context: BusinessProfileContext): {
  readonly workspaceId: WorkspaceId;
  readonly businessProfileId: BusinessProfileId;
} {
  if (typeof context !== "object" || context === null || !issuedBusinessProfileContexts.has(context)) {
    throw new BusinessProfileAccessDeniedError();
  }
  return { workspaceId: context.workspaceId, businessProfileId: context.businessProfileId };
}

export const WORKSPACE_ADMIN_ROLES: readonly WorkspaceRole[] = ["OWNER", "ADMIN"];

/** Role check for an issued context (validated first); returns nothing, throws WorkspacePermissionError. */
/**
 * Whether this caller may write something that reaches beyond their own Business Profile (#57).
 *
 * A Workspace-scoped knowledge document or style example is read by *every* profile, so creating or
 * editing one from a single-profile screen is a cross-profile write — and until this existed any member
 * who could open the Knowledge page could make one, including an agent granted a single profile. The
 * check is the one `createBusinessProfile` already applies to the other workspace-wide act: admin or
 * owner, and `ALL` scope, because somebody granted two profiles out of five has not been given the
 * authority to change what the other three read.
 *
 * It takes a `WorkspaceContext` because a profile context cannot answer it: `BusinessProfileContext`
 * deliberately carries no scope, so a caller holding only one has to go and get the wider one.
 */
export function requireWorkspaceWideWrite(context: WorkspaceContext, operation: string): void {
  requireRole(context, WORKSPACE_ADMIN_ROLES, operation);
  if (context.businessProfileScope.kind !== "ALL") {
    throw new WorkspacePermissionError(operation);
  }
}

export function requireRole(
  context: WorkspaceContext | BusinessProfileContext,
  allowed: readonly WorkspaceRole[],
  operation: string,
): void {
  const issued =
    typeof context === "object" &&
    context !== null &&
    (issuedWorkspaceContexts.has(context) || issuedBusinessProfileContexts.has(context));
  if (!issued) {
    throw new WorkspaceAccessDeniedError();
  }
  if (!allowed.includes(context.role)) {
    throw new WorkspacePermissionError(operation);
  }
}

/** Prisma filter limiting Business Profile owned rows to the profiles a Workspace context may see. */
export function authorizedBusinessProfileFilter(context: WorkspaceContext): { businessProfileId?: { in: BusinessProfileId[] } } {
  scopeOf(context);
  return context.businessProfileScope.kind === "ALL"
    ? {}
    : { businessProfileId: { in: [...context.businessProfileScope.businessProfileIds] } };
}
