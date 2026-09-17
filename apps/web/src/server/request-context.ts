import type { BusinessProfileContext, WorkspaceContext } from "@omnichannel/db";

import { auth } from "../auth";
import { getDb } from "./db";
import { resolveBusinessProfileContext, resolveWorkspaceContext, type WorkspaceContextDependencies } from "./workspace-context";

function dependencies(): WorkspaceContextDependencies {
  return {
    getSessionUserId: async () => (await auth())?.user?.id,
    db: getDb(),
  };
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
