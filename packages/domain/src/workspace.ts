import type { BusinessProfileId, UserId, WorkspaceId, WorkspaceMemberId } from "./ids";
import { literalGuard } from "./enum";

/** Tenant and billing boundary. Customer data lives in its Business Profiles (DATA_MODEL.md v0.4 §1). */
export interface Workspace {
  readonly id: WorkspaceId;
  readonly name: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** MVP workspace roles (ADR-009): the role answers **what** a member may do. */
export const WORKSPACE_ROLES = ["OWNER", "ADMIN", "AGENT"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];
export const isWorkspaceRole = literalGuard(WORKSPACE_ROLES);

/**
 * Business Profile access answers **where** a member may act (TEAM_ROLES_UX.md). ALL covers every current
 * and future Business Profile of the Workspace; SELECTED covers only explicitly granted profiles, and no
 * grants means no access. OWNER always has ALL.
 */
export const BUSINESS_PROFILE_ACCESS_SCOPES = ["ALL", "SELECTED"] as const;
export type BusinessProfileAccessScope = (typeof BUSINESS_PROFILE_ACCESS_SCOPES)[number];
export const isBusinessProfileAccessScope = literalGuard(BUSINESS_PROFILE_ACCESS_SCOPES);

export interface WorkspaceMember {
  readonly id: WorkspaceMemberId;
  readonly workspaceId: WorkspaceId;
  readonly userId: UserId;
  readonly role: WorkspaceRole;
  readonly businessProfileScope: BusinessProfileAccessScope;
  readonly createdAt: Date;
}

/** Explicit grant of one Business Profile to a SELECTED-scope member of the same Workspace. */
export interface MemberBusinessProfileAccess {
  readonly workspaceId: WorkspaceId;
  readonly workspaceMemberId: WorkspaceMemberId;
  readonly businessProfileId: BusinessProfileId;
}

export interface BusinessProfileAccessGrant {
  readonly role: WorkspaceRole;
  readonly businessProfileScope: BusinessProfileAccessScope;
  /** Granted profiles; only consulted for SELECTED scope. */
  readonly grantedBusinessProfileIds: readonly BusinessProfileId[];
}

/**
 * Whether a member may act in a Business Profile of their Workspace. OWNER and ALL scope cover every
 * profile; SELECTED covers only granted profiles. Callers must also check that the profile belongs to the
 * member's Workspace; this rule only evaluates the grant.
 */
export function hasBusinessProfileAccess(grant: BusinessProfileAccessGrant, businessProfileId: BusinessProfileId): boolean {
  if (grant.role === "OWNER" || grant.businessProfileScope === "ALL") {
    return true;
  }
  return grant.grantedBusinessProfileIds.includes(businessProfileId);
}
