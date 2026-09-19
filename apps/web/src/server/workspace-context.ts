import {
  authorizeBusinessProfileAccess,
  authorizeWorkspaceAccess,
  BusinessProfileAccessDeniedError,
  WorkspaceAccessDeniedError,
  type BusinessProfileContext,
  type DbExecutor,
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
