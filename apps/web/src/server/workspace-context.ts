import {
  authorizeWorkspaceAccess,
  WorkspaceAccessDeniedError,
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

/**
 * Resolves the tenant context for one server request (ADR-009). The session only proves who the user is;
 * the workspace must be named explicitly by the request (e.g. a route segment) and is authorized by
 * membership. There is no implicit "current" or default workspace.
 */
export async function resolveWorkspaceContext(
  dependencies: WorkspaceContextDependencies,
  workspaceId: string | undefined,
): Promise<WorkspaceContext> {
  const userId = await dependencies.getSessionUserId();
  if (userId === undefined || userId === "") {
    throw new UnauthenticatedError();
  }
  if (workspaceId === undefined || workspaceId === "") {
    throw new WorkspaceAccessDeniedError();
  }
  return authorizeWorkspaceAccess(dependencies.db, { userId, workspaceId });
}
