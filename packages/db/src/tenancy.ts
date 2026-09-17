/**
 * Explicit workspace authorization (ADR-009). Browser/session identity says who the user is; it never
 * implies a workspace. Every tenant-data repository function takes a `WorkspaceContext`, and the only way
 * to obtain one is `authorizeWorkspaceAccess`, which checks membership for an explicitly selected workspace.
 */
import {
  isValidIdentifier,
  toUserId,
  toWorkspaceId,
  type UserId,
  type WorkspaceId,
  type WorkspaceRole,
} from "@omnichannel/domain";

import type { DbExecutor } from "./client";
import { WorkspaceAccessDeniedError, WorkspacePermissionError } from "./errors";

declare const workspaceContextBrand: unique symbol;

export interface WorkspaceContext {
  readonly workspaceId: WorkspaceId;
  readonly userId: UserId;
  /** Role at authorization time. Contexts are per request; authorize again for each request. */
  readonly role: WorkspaceRole;
  readonly [workspaceContextBrand]: true;
}

export interface WorkspaceAccessRequest {
  /** Authenticated user from the Auth.js session. */
  readonly userId: string;
  /** Workspace explicitly selected by the request (route/header), never guessed. */
  readonly workspaceId: string;
}

/** Contexts issued by `authorizeWorkspaceAccess`; structurally identical objects built elsewhere are rejected. */
const issuedContexts = new WeakSet<object>();

export async function authorizeWorkspaceAccess(db: DbExecutor, request: WorkspaceAccessRequest): Promise<WorkspaceContext> {
  if (!isValidIdentifier(request.userId) || !isValidIdentifier(request.workspaceId)) {
    throw new WorkspaceAccessDeniedError();
  }
  const membership = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: request.workspaceId, userId: request.userId } },
    select: { role: true },
  });
  if (membership === null) {
    throw new WorkspaceAccessDeniedError();
  }

  const context = Object.freeze({
    workspaceId: toWorkspaceId(request.workspaceId),
    userId: toUserId(request.userId),
    role: membership.role,
  }) as WorkspaceContext;
  issuedContexts.add(context);
  return context;
}

/** Returns the workspace to scope queries by, rejecting contexts that did not come from authorization. */
export function scopeOf(context: WorkspaceContext): WorkspaceId {
  if (typeof context !== "object" || context === null || !issuedContexts.has(context)) {
    throw new WorkspaceAccessDeniedError();
  }
  return context.workspaceId;
}

export const WORKSPACE_ADMIN_ROLES: readonly WorkspaceRole[] = ["OWNER", "ADMIN"];

export function requireWorkspaceRole(context: WorkspaceContext, allowed: readonly WorkspaceRole[], operation: string): WorkspaceId {
  const workspaceId = scopeOf(context);
  if (!allowed.includes(context.role)) {
    throw new WorkspacePermissionError(operation);
  }
  return workspaceId;
}
