import { literalGuard } from "./enum";
import type { UserId, WorkspaceId } from "./ids";

/** Tenant boundary: every customer-owned record belongs to exactly one workspace (ADR-009). */
export interface Workspace {
  readonly id: WorkspaceId;
  readonly name: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** MVP workspace roles (ADR-009); fine-grained RBAC is post-MVP. */
export const WORKSPACE_ROLES = ["OWNER", "ADMIN", "AGENT"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];
export const isWorkspaceRole = literalGuard(WORKSPACE_ROLES);

export interface WorkspaceMember {
  readonly workspaceId: WorkspaceId;
  readonly userId: UserId;
  readonly role: WorkspaceRole;
  readonly createdAt: Date;
}
