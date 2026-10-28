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
import { profileDefaultPolicyWrite } from "../policy-store";
import {
  authorizedBusinessProfileFilter,
  requireRole,
  requireWorkspaceWideWrite,
  scopeOf,
  WORKSPACE_ADMIN_ROLES,
  type WorkspaceContext,
} from "../tenancy";
import { recordWorkspaceAuditEvent } from "../audit-store";

/**
 * The longest a Workspace or Business Profile name may be.
 *
 * Exported because a form has to refuse an overlong name *before* submitting it, and a second number
 * written in the web app would be free to disagree with this one: a field that accepted 240 characters
 * would hand the person a `DbInputError` from two layers down instead of the sentence their own screen
 * should have told them. One constant, read by both.
 */
export const NAME_MAX_LENGTH = 200;

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
  if (name.length === 0 || name.length > NAME_MAX_LENGTH) {
    throw new DbInputError(field, `must be 1-${NAME_MAX_LENGTH} characters`);
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
 * The same creation, made safe to submit twice (#115).
 *
 * The front door is a form, and a form is submitted twice: a double-click, a retried POST, a back button
 * into a resubmit. `createWorkspaceWithOwner` is a plain insert with nothing to collide on — the schema
 * caps identity, not repetition — so two submissions of one intent produce two workspaces with the same
 * name, and the second is permanent: nothing in the product deletes a workspace. That is the shape this
 * function exists to refuse.
 *
 * **A check followed by an insert is not atomic, so the check is taken under the lock the insert runs
 * under.** The same transaction-scoped advisory lock the capacity checks in this file use, keyed to the
 * owner and the name they typed, because two concurrent submissions of the identical form are precisely
 * the case a read-then-write loses: both read nothing and both insert. Keyed to the *normalized* name, so
 * `"  Acme  "` and `"Acme"` take the same lock rather than racing each other past it.
 *
 * Replay is reported rather than hidden. `replayed` lets the caller say "this already exists" instead of
 * claiming a creation that did not happen, and the workspace returned is the existing one, so a person
 * who clicked twice lands where they meant to go either way.
 *
 * Deliberately scoped to *this owner's* workspaces, and to the OWNER membership specifically: two
 * businesses may legitimately both be called "Studio", and a member of someone else's "Studio" has not
 * thereby created one. A second workspace with a name this owner has already used is refused as a replay —
 * the documented limit of this strategy, and the better answer anyway, since two identically named
 * workspaces in one chooser cannot be told apart by the person choosing.
 */
export async function createWorkspaceOnce(
  db: DbClient,
  input: { readonly name: string; readonly ownerUserId: string },
): Promise<{ readonly workspace: WorkspaceMembershipSummary; readonly replayed: boolean }> {
  if (!isValidIdentifier(input.ownerUserId)) {
    throw new DbInputError("ownerUserId", "must be a valid identifier");
  }
  // Normalized before the lock and before the lookup: the stored name is the normalized one, so a key or
  // a comparison built from the raw field would miss the row it is meant to find.
  const name = normalizeName("name", input.name);
  return db.$transaction(async (tx) => {
    await serializeCapacity(tx, `workspace-create:${input.ownerUserId}:${name}`);
    const existing = await tx.workspaceMember.findFirst({
      where: { userId: input.ownerUserId, role: "OWNER", workspace: { name } },
      select: { role: true, workspace: { select: { id: true, name: true } } },
      orderBy: { createdAt: "asc" },
    });
    if (existing !== null) {
      return {
        workspace: { workspaceId: toWorkspaceId(existing.workspace.id), name: existing.workspace.name, role: existing.role },
        replayed: true,
      };
    }
    return { workspace: await createWorkspaceWithOwner(tx, { name, ownerUserId: input.ownerUserId }), replayed: false };
  });
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
  db: DbClient,
  context: WorkspaceContext,
  input: { readonly name: string },
  /** When the entitlement is resolved. Explicit, because a plan's own validity is a question about a moment. */
  at = new Date(),
): Promise<BusinessProfileSummary> {
  const workspaceId = scopeOf(context);
  // The one implementation of "admin or owner, and every profile in scope". This used to inline the two
  // checks while `requireWorkspaceWideWrite` existed to express exactly them — and that function's own
  // comment cited *this* call site as the rule it copied, so the rule had two bodies and neither knew.
  requireWorkspaceWideWrite(context, "creating Business Profiles");
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
  // `entitlements.integration.test.ts` pins the PostgreSQL fact this argument rests on — an advisory
  // lock taken under autocommit is gone by the next statement, one taken inside a transaction
  // survives it. It does **not** call this function, so deleting the `serializeCapacity` line below
  // fails no test today; measured, not assumed. What would close that is an observer reading
  // `pg_locks` while this transaction's count-and-insert runs.
  //
  // A workspace with no subscription has no stated ceiling and may therefore create its first Business
  // Profile. Creating one does not start the trial — connecting it to a channel does, in
  // `connectChannelAccount` — so refusing this would make the product unreachable from its own front door
  // and the trial unstartable.
  //
  // `connectChannelAccount` and not `createChannelAccount`, which this comment named until #115 went
  // looking for the trial on the strength of it. Only the former calls `ensureWorkspaceTrial`; following
  // the old name leads to a function that connects an account and starts nothing, with no error to say so.
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
      data: {
        workspaceId,
        name: normalizeName("name", input.name),
        // `channelAccountId` left absent: this is the profile default, the policy every channel
        // account of the profile inherits until one is given an override of its own. The capacity
        // check above and this nested write are now in one transaction, so a profile cannot exist
        // without the policy it is born with.
        automationPolicies: { create: profileDefaultPolicyWrite() },
      },
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
