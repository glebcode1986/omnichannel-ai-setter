import {
  isValidIdentifier,
  toBusinessProfileId,
  toWorkspaceId,
  toWorkspaceMemberId,
  type BusinessProfileId,
  type BusinessProfileStatus,
  type WorkspaceId,
  type WorkspaceMemberId,
  type WorkspaceRole,
} from "@omnichannel/domain";

import type { DbClient, DbExecutor } from "../client";
import { DbInputError, rethrowAsTenantNotFound, WorkspacePermissionError } from "../errors";
import { profileDefaultPolicyWrite } from "../policy-store";
import {
  authorizedBusinessProfileFilter,
  requireRole,
  scopeOf,
  WORKSPACE_ADMIN_ROLES,
  type WorkspaceContext,
} from "../tenancy";
import { recordWorkspaceAuditEvent } from "../audit-store";

const MAX_NAME_LENGTH = 200;

export interface WorkspaceMembershipSummary {
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly role: WorkspaceRole;
}

export interface BusinessProfileSummary {
  readonly businessProfileId: BusinessProfileId;
  readonly name: string;
  readonly status: BusinessProfileStatus;
}

/** Scope granted to a new member: every Business Profile, or an explicit list (possibly empty). */
export type BusinessProfileScopeGrant = "ALL" | { readonly selected: readonly string[] };

function normalizeName(field: string, value: string): string {
  const name = value.trim();
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    throw new DbInputError(field, `must be 1-${MAX_NAME_LENGTH} characters`);
  }
  return name;
}

/**
 * Creates a workspace and makes the authenticated creator its OWNER (scope ALL) in one statement. No Business
 * Profile is created implicitly; the owner creates profiles explicitly.
 */
export async function createWorkspaceWithOwner(
  db: DbExecutor,
  input: { readonly name: string; readonly ownerUserId: string },
): Promise<WorkspaceMembershipSummary> {
  if (!isValidIdentifier(input.ownerUserId)) {
    throw new DbInputError("ownerUserId", "must be a valid identifier");
  }
  const workspace = await db.workspace.create({
    data: {
      name: normalizeName("name", input.name),
      members: { create: { userId: input.ownerUserId, role: "OWNER", businessProfileScope: "ALL" } },
    },
    select: { id: true, name: true },
  });
  return { workspaceId: toWorkspaceId(workspace.id), name: workspace.name, role: "OWNER" };
}

/**
 * Workspaces the user may select. Used to offer an explicit choice; it does not authorize anything — each
 * request still authorizes the Workspace/Business Profile it names.
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

/**
 * Creates a Business Profile (status SETUP) together with its automation settings. Allowed for OWNER and
 * for an ADMIN whose scope is ALL, because a new profile is automatically visible to every ALL-scoped
 * member. Provisional rule until team/billing tasks define profile-slot permissions.
 *
 * The automation default is created **in the same statement**, and that is not a convenience. Settings are
 * read by Business Profile and there is no "no settings" state anywhere above this line: the owner's
 * settings screen renders the stored policy, so a profile without one renders no form, offers no first
 * save, and leaves automation at OFF with no way to change it — a profile that exists, is listed, accepts a
 * channel account and cannot be configured. Prisma writes a nested create inside the profile's own
 * transaction, so the two rows arrive together or neither does, and nothing in between is observable.
 *
 * Not a separate call afterwards, for the same reason: two statements can be interrupted between them, and
 * the thing left behind is exactly the half-made profile described above. Not lazily, on first read,
 * either — reading settings is permitted to any member who may see the profile, writing them is OWNER/ADMIN
 * only, and an initialization hidden inside a read would have to break that boundary to work.
 */
export async function createBusinessProfile(
  db: DbExecutor,
  context: WorkspaceContext,
  input: { readonly name: string },
): Promise<BusinessProfileSummary> {
  const workspaceId = scopeOf(context);
  requireRole(context, WORKSPACE_ADMIN_ROLES, "creating Business Profiles");
  if (context.businessProfileScope.kind !== "ALL") {
    throw new WorkspacePermissionError("creating Business Profiles");
  }
  const profile = await db.businessProfile.create({
    data: {
      workspaceId,
      name: normalizeName("name", input.name),
      // `channelAccountId` left absent: this is the profile default, the policy every channel account of
      // the profile inherits until one is given an override of its own.
      automationPolicies: { create: profileDefaultPolicyWrite() },
    },
    select: { id: true, name: true, status: true },
  });
  return { businessProfileId: toBusinessProfileId(profile.id), name: profile.name, status: profile.status };
}

/** Business Profiles the member may see; unauthorized profiles are not listed. */
export async function listAuthorizedBusinessProfiles(db: DbExecutor, context: WorkspaceContext): Promise<BusinessProfileSummary[]> {
  const workspaceId = scopeOf(context);
  const filter = authorizedBusinessProfileFilter(context);
  const profiles = await db.businessProfile.findMany({
    where: { workspaceId, ...(filter.businessProfileId === undefined ? {} : { id: filter.businessProfileId }) },
    select: { id: true, name: true, status: true },
    orderBy: { createdAt: "asc" },
  });
  return profiles.map((profile) => ({
    businessProfileId: toBusinessProfileId(profile.id),
    name: profile.name,
    status: profile.status,
  }));
}

/**
 * Adds a member with an explicit Business Profile scope. OWNER/ADMIN may add members; only an OWNER may grant
 * OWNER (always scope ALL). Grants are bounded by the granting member's own scope: an ADMIN with SELECTED
 * scope can neither grant ALL nor a profile outside its own grants.
 */
export async function addWorkspaceMember(
  db: DbClient,
  context: WorkspaceContext,
  input: { readonly userId: string; readonly role: WorkspaceRole; readonly businessProfileScope: BusinessProfileScopeGrant },
): Promise<{ readonly workspaceMemberId: WorkspaceMemberId }> {
  const workspaceId = scopeOf(context);
  requireRole(context, WORKSPACE_ADMIN_ROLES, "adding members");
  if (input.role === "OWNER" && context.role !== "OWNER") {
    throw new WorkspacePermissionError("granting OWNER");
  }
  if (!isValidIdentifier(input.userId)) {
    throw new DbInputError("userId", "must be a valid identifier");
  }

  const grantsAll = input.role === "OWNER" || input.businessProfileScope === "ALL";
  const selected = input.businessProfileScope === "ALL" || grantsAll ? [] : [...new Set(input.businessProfileScope.selected)];
  if (selected.some((id) => !isValidIdentifier(id))) {
    throw new DbInputError("businessProfileScope", "must list valid Business Profile identifiers");
  }
  const granterScope = context.businessProfileScope;
  if (granterScope.kind === "SELECTED") {
    const own = new Set<string>(granterScope.businessProfileIds);
    if (grantsAll || selected.some((id) => !own.has(id))) {
      throw new WorkspacePermissionError("granting Business Profile access outside the granting member's scope");
    }
  }

  try {
    return await db.$transaction(async (tx) => {
      const member = await tx.workspaceMember.create({
        data: { workspaceId, userId: input.userId, role: input.role, businessProfileScope: grantsAll ? "ALL" : "SELECTED" },
        select: { id: true },
      });
      if (selected.length > 0) {
        await tx.memberBusinessProfileAccess.createMany({
          data: selected.map((businessProfileId) => ({ workspaceId, workspaceMemberId: member.id, businessProfileId })),
        });
      }
      // A workspace-level event, because who may act is not any one profile's business — and admin-only
      // to read, because it is the record of who was given reach over customers.
      await recordWorkspaceAuditEvent(tx, context, {
        kind: "MEMBER_CHANGED",
        summary: `Added a member as ${input.role}`,
        subjectType: "workspace_members",
        subjectId: member.id,
        actorUserId: context.userId,
        detail: { role: input.role, scope: grantsAll ? "ALL" : "SELECTED", businessProfileIds: selected },
      });
      return { workspaceMemberId: toWorkspaceMemberId(member.id) };
    });
  } catch (error) {
    // A listed profile outside this Workspace fails the composite FK and is reported like a missing one.
    return rethrowAsTenantNotFound(error, "BusinessProfile");
  }
}
