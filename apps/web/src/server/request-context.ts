import type { BusinessProfileContext, PlatformContext, WorkspaceContext } from "@omnichannel/db";

import { auth } from "../auth";
import { getDb } from "./db";
import {
  requireSessionUser,
  resolveBusinessProfileContext,
  resolvePlatformContext,
  resolveWorkspaceContext,
  type WorkspaceContextDependencies,
} from "./workspace-context";

function dependencies(): WorkspaceContextDependencies {
  return {
    getSessionUserId: async () => (await auth())?.user?.id,
    db: getDb(),
  };
}

/**
 * The authenticated user id for this request, for the two callers that have no Workspace to name yet
 * (#115): the chooser and the action that creates the first Workspace.
 *
 * Authentication only — see `requireSessionUser`. Deliberately *not* one of the resolvers the route
 * authorization gate accepts, so this cannot become a way to serve a page that reads a tenant's data
 * without authorizing the tenant.
 */
export function requireSessionUserId(): Promise<string> {
  return requireSessionUser(dependencies());
}

/** Workspace context for the current request's session and the Workspace the request names explicitly. */
export function requireWorkspaceContext(workspaceId: string | undefined): Promise<WorkspaceContext> {
  return resolveWorkspaceContext(dependencies(), workspaceId);
}

/** Business Profile context for the current request's session and the Workspace + profile it names. */
export function requireBusinessProfileContext(
  workspaceId: string | undefined,
  businessProfileId: string | undefined,
): Promise<BusinessProfileContext> {
  return resolveBusinessProfileContext(dependencies(), workspaceId, businessProfileId);
}

/**
 * The internal control plane's context for this request (#59).
 *
 * Every page and route under `/admin` calls this and nothing else. `route-authorization.test.ts` walks
 * the route tree and fails the build for a page whose own source — or an ancestor layout's — does not
 * call one of the three resolvers, because the app has no middleware and a forgotten call in one file
 * would be an unauthenticated internal console page that nothing else notices.
 */
export function requirePlatformContext(): Promise<PlatformContext> {
  return resolvePlatformContext(dependencies());
}
