import {
  capacityVerdict,
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
import { DbInputError, PlanLimitError, rethrowAsTenantNotFound, WorkspacePermissionError } from "../errors";
import { readEntitlement } from "../entitlement-store";
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
 * Creates a Business Profile (status SETUP). Allowed for OWNER and for an ADMIN whose scope is ALL, because
 * a new profile is automatically visible to every ALL-scoped member. Provisional rule until team/billing
 * tasks define profile-slot permissions.
 */
export async function createBusinessProfile(
  db: DbClient,
  context: WorkspaceContext,
  input: { readonly name: string },
  /** When the entitlement is resolved. Explicit, because a plan's own validity is a question about a moment. */
  at = new Date(),
): Promise<BusinessProfileSummary> {
  const workspaceId = scopeOf(context);
  requireRole(context, WORKSPACE_ADMIN_ROLES, "creating Business Profiles");
  if (context.businessProfileScope.kind !== "ALL") {
    throw new WorkspacePermissionError("creating Business Profiles");
  }
  // Capacity, as capacity rather than as payment (#40).
  //
  // Counted and written under one advisory lock **inside one transaction**, which is the whole mechanism:
  // a count followed by an insert is not atomic and no index caps a count, so two concurrent creates on a
  // one-profile plan would both see zero and both succeed.
  //
  // The transaction is opened here rather than left to the caller, and that is a correction. This took a
  // `DbExecutor` — a type that deliberately omits `$transaction` — and so the lock could never outlive
  // the statement that took it: PostgreSQL releases an `xact` lock when its transaction ends, and under
  // autocommit that is the lock statement itself, after which `pg_locks` reports none held. The
  // serialization this comment promised was therefore a no-op unless a caller happened to already be in
  // a transaction, and nothing said one had to be. `addWorkspaceMember` takes a `DbClient` and opens one
  // for the identical count-then-insert on seats; this now matches it, and
  // `entitlements.integration.test.ts` pins the lock lifetime the argument rests on.
  //
  // A workspace with no subscription has no stated ceiling and may therefore create its first Business
  // Profile — which is the act the accepted trial policy says *starts* the trial, so refusing it would
  // make the product unreachable from its own front door.
  return db.$transaction(async (tx) => {
    await serializeCapacity(tx, `workspace-profiles:${workspaceId}`);
    const verdict = capacityVerdict({
      snapshot: await readEntitlement(tx as unknown as DbClient, workspaceId, at),
      limit: "BUSINESS_PROFILES",
      current: await tx.businessProfile.count({ where: { workspaceId } }),
    });
    if (verdict.kind !== "ALLOWED") {
      throw new PlanLimitError(verdict, "creating a Business Profile");
    }

    const profile = await tx.businessProfile.create({
      data: { workspaceId, name: normalizeName("name", input.name) },
      select: { id: true, name: true, status: true },
    });
    return { businessProfileId: toBusinessProfileId(profile.id), name: profile.name, status: profile.status };
  });
}

/**
 * Serializes a count-then-insert on one name, for the transaction's lifetime.
 *
 * Nothing in the schema caps a count — the unique indexes cover identity, not quantity — so a capacity
 * check is a read followed by a write, and two of those interleave. A transaction-scoped advisory lock is
 * the mechanism the usage ledger already uses for the same shape, and it is released however the
 * transaction ends, so there is nothing to leak.
 *
 * Called in `FROM` and given a column, because the lock function returns `void` and the client cannot
 * deserialize a void column.
 */
async function serializeCapacity(db: DbExecutor, name: string): Promise<void> {
  await db.$queryRaw`SELECT true AS locked FROM pg_advisory_xact_lock(hashtextextended(${name}, 0))`;
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
  /** As above: the plan's validity is a question about a moment, and the caller owns the clock. */
  at = new Date(),
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
      // Capacity and the multi-member feature, under one lock for the reason the profile count is: two
      // concurrent adds on a three-seat plan would both see two and both succeed.
      //
      // The feature is consulted only from the second member onwards. Every workspace has an owner, and a
      // plan that does not sell a *team* has not thereby forbidden the person who owns the workspace.
      await serializeCapacity(tx, `workspace-seats:${workspaceId}`);
      const seats = capacityVerdict({
        snapshot: await readEntitlement(tx as unknown as DbClient, workspaceId, at),
        limit: "SEATS",
        current: await tx.workspaceMember.count({ where: { workspaceId } }),
        requires: { feature: "MULTI_MEMBER", from: 1 },
      });
      if (seats.kind !== "ALLOWED") {
        throw new PlanLimitError(seats, "adding a member");
      }
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
