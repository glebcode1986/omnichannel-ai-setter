import {
  authorizeBusinessProfileAccess,
  authorizePlatformAccess,
  authorizeWorkspaceAccess,
  BusinessProfileAccessDeniedError,
  WorkspaceAccessDeniedError,
  type BusinessProfileContext,
  type DbExecutor,
  type PlatformContext,
  type WorkspaceContext,
} from "@omnichannel/db";

export class UnauthenticatedError extends Error {
  constructor() {
    super("Authentication required");
    this.name = "UnauthenticatedError";
  }
}

export interface WorkspaceContextDependencies {
  /** Authenticated user ID from the Auth.js session, if any. */
  readonly getSessionUserId: () => Promise<string | undefined>;
  readonly db: DbExecutor;
}

async function requireSessionUser(dependencies: WorkspaceContextDependencies): Promise<string> {
  const userId = await dependencies.getSessionUserId();
  if (userId === undefined || userId === "") {
    throw new UnauthenticatedError();
  }
  return userId;
}

/**
 * Resolves the Workspace context for one server request (ADR-009). The session only proves who the user is;
 * the Workspace must be named explicitly by the request (e.g. a route segment) and is authorized by
 * membership. There is no implicit "current" or default Workspace.
 */
export async function resolveWorkspaceContext(
  dependencies: WorkspaceContextDependencies,
  workspaceId: string | undefined,
): Promise<WorkspaceContext> {
  const userId = await requireSessionUser(dependencies);
  if (workspaceId === undefined || workspaceId === "") {
    throw new WorkspaceAccessDeniedError();
  }
  return authorizeWorkspaceAccess(dependencies.db, { userId, workspaceId });
}

/**
 * Resolves the Business Profile context for one server request (DATA_MODEL.md v0.4). Both the Workspace and
 * the Business Profile must be named explicitly; the profile is never defaulted to a "first" or remembered
 * one. Role and profile scope are re-read on every request and never stored in the session.
 */
export async function resolveBusinessProfileContext(
  dependencies: WorkspaceContextDependencies,
  workspaceId: string | undefined,
  businessProfileId: string | undefined,
): Promise<BusinessProfileContext> {
  const userId = await requireSessionUser(dependencies);
  if (workspaceId === undefined || workspaceId === "") {
    throw new WorkspaceAccessDeniedError();
  }
  if (businessProfileId === undefined || businessProfileId === "") {
    throw new BusinessProfileAccessDeniedError();
  }
  return authorizeBusinessProfileAccess(dependencies.db, { userId, workspaceId, businessProfileId });
}

/**
 * Resolves the internal control plane's context for one server request (#59, ADMIN_OPERATIONS.md).
 *
 * The session proves who the user is, exactly as it does for a customer, and then a *different* lookup
 * decides what they may do: `platform_members` rather than `workspace_members`. It names no workspace,
 * because reading across tenants is the privilege — the workspace is a parameter of every read rather
 * than a property of the caller.
 *
 * Deliberately no fallback to the customer path and no widening of it. A `PlatformContext` is refused by
 * `scopeOf`, `profileScopeOf` and `requireRole`, and that refusal is the guarantee: an operator can never
 * hold customer `OWNER` authority by holding this.
 */
export async function resolvePlatformContext(dependencies: WorkspaceContextDependencies): Promise<PlatformContext> {
  const userId = await requireSessionUser(dependencies);
  return authorizePlatformAccess(dependencies.db, userId);
}
