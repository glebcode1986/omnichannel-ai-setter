import type { WorkspaceContext } from "@omnichannel/db";

import { auth } from "../auth";
import { getDb } from "./db";
import { resolveWorkspaceContext } from "./workspace-context";

/** Workspace context for the current request's session and the workspace the request names explicitly. */
export function requireWorkspaceContext(workspaceId: string | undefined): Promise<WorkspaceContext> {
  return resolveWorkspaceContext(
    {
      getSessionUserId: async () => (await auth())?.user?.id,
      db: getDb(),
    },
    workspaceId,
  );
}
