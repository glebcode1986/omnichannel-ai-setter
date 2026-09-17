import { isValidIdentifier, toWorkspaceId, type WorkspaceId, type WorkspaceRole } from "@omnichannel/domain";

import type { DbExecutor } from "../client";
import { DbInputError, WorkspacePermissionError } from "../errors";
import { requireWorkspaceRole, WORKSPACE_ADMIN_ROLES, type WorkspaceContext } from "../tenancy";

const MAX_NAME_LENGTH = 200;

export interface WorkspaceMembershipSummary {
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly role: WorkspaceRole;
}

/** Creates a workspace and makes the authenticated creator its OWNER in one statement. */
export async function createWorkspaceWithOwner(
  db: DbExecutor,
  input: { readonly name: string; readonly ownerUserId: string },
): Promise<WorkspaceMembershipSummary> {
  if (!isValidIdentifier(input.ownerUserId)) {
    throw new DbInputError("ownerUserId", "must be a valid identifier");
  }
  const name = input.name.trim();
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    throw new DbInputError("name", `must be 1-${MAX_NAME_LENGTH} characters`);
  }

  const workspace = await db.workspace.create({
    data: { name, members: { create: { userId: input.ownerUserId, role: "OWNER" } } },
    select: { id: true, name: true },
  });
  return { workspaceId: toWorkspaceId(workspace.id), name: workspace.name, role: "OWNER" };
}

/**
 * Workspaces the user may select. Used to offer an explicit choice; it does not authorize anything —
 * each request still calls `authorizeWorkspaceAccess` for the workspace it names.
 */
export async function listWorkspacesForUser(db: DbExecutor, userId: string): Promise<WorkspaceMembershipSummary[]> {
  if (!isValidIdentifier(userId)) {
    return [];
  }
  const memberships = await db.workspaceMember.findMany({
    where: { userId },
    select: { role: true, workspace: { select: { id: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
  return memberships.map((membership) => ({
    workspaceId: toWorkspaceId(membership.workspace.id),
    name: membership.workspace.name,
    role: membership.role,
  }));
}

/** OWNER/ADMIN may add members; only an OWNER may grant OWNER. */
export async function addWorkspaceMember(
  db: DbExecutor,
  context: WorkspaceContext,
  input: { readonly userId: string; readonly role: WorkspaceRole },
): Promise<void> {
  const workspaceId = requireWorkspaceRole(context, WORKSPACE_ADMIN_ROLES, "adding members");
  if (input.role === "OWNER" && context.role !== "OWNER") {
    throw new WorkspacePermissionError("granting OWNER");
  }
  if (!isValidIdentifier(input.userId)) {
    throw new DbInputError("userId", "must be a valid identifier");
  }
  await db.workspaceMember.create({ data: { workspaceId, userId: input.userId, role: input.role } });
}
