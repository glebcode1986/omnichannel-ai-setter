/**
 * Internal staff authorization, kept structurally apart from a customer's (#59, ADMIN_OPERATIONS.md).
 *
 * `tenancy.ts` answers "may this member act in this workspace?". This answers a different question —
 * "may this member of staff operate the platform?" — and the whole design of the file is about making
 * sure the two answers can never be mistaken for one another.
 *
 * **Why a parallel context and not a second issuer inside `tenancy.ts`.** The obvious shortcut is to mint
 * a `BusinessProfileContext` for an operator so that every existing customer-data read works unchanged.
 * It is also the worst thing this codebase could do. That type carries `role: WorkspaceRole`, and that
 * field is not decorative: dozens of `requireRole` sites accept it, so a context minted with `role:
 * "OWNER"` for a support engineer is indistinguishable from a real owner's — and the same object would be
 * accepted by the deletion path, by `addWorkspaceMember`, by `setEntitlementOverride` and by the data
 * export. Worse for attribution, those paths write `actorUserId` into the *customer's* audit log, so an
 * internal action would appear as a member's own action, readable by that customer's owner. Widening the
 * membership lookup instead is worse again: a staff row in `workspace_members` would appear in that
 * user's workspace list and consume a seat the customer pays for.
 *
 * So `PlatformContext` has its own brand and its own `WeakSet`, and `scopeOf`, `profileScopeOf` and
 * `requireRole` **reject it**. That rejection is the feature. No function anywhere may accept
 * `WorkspaceContext | PlatformContext`: the moment one does, `scopeOf` stops meaning "a member
 * authorized this", and `platform-boundary.test.ts` asserts that no exported signature does.
 *
 * Platform reads live in `platform-read-store.ts` and take this context plus an explicit workspace (and
 * profile where relevant), bounding every query by both — because an operator legitimately reads across
 * tenants, so there is no membership to narrow the query for them and the narrowing has to be written out.
 *
 * Contexts are issued per request from the stored role, exactly as the customer's are, so a withdrawn
 * platform role is authoritative for the next request.
 */
import {
  isPlatformRole,
  platformPermitted,
  toUserId,
  type PlatformPermission,
  type PlatformRole,
  type UserId,
} from "@omnichannel/domain";

import type { DbExecutor } from "./client";
import { PlatformAccessDeniedError, PlatformPermissionError } from "./errors";

declare const platformContextBrand: unique symbol;

/**
 * An authorized member of staff, for one request.
 *
 * Carries no workspace. An operator is not scoped to a tenant — reading across tenants is the privilege —
 * so the workspace is a parameter of every read rather than a property of the caller, which is the
 * opposite of how the customer contexts work and is the right way round for this one.
 */
export interface PlatformContext {
  readonly platformMemberId: string;
  readonly userId: UserId;
  readonly role: PlatformRole;
  readonly [platformContextBrand]: true;
}

const issuedPlatformContexts = new WeakSet<object>();

/**
 * Authorizes a member of staff, or refuses.
 *
 * A user with no `platform_members` row and a user whose role was withdrawn fail identically, for the
 * reason `authorizeBusinessProfileAccess` gives about profiles: a distinguishable refusal tells somebody
 * which user ids are staff.
 */
export async function authorizePlatformAccess(db: DbExecutor, userId: string): Promise<PlatformContext> {
  const member =
    userId.trim() === ""
      ? null
      : await db.platformMember.findUnique({
          where: { userId },
          select: { id: true, role: true, revokedAt: true },
        });
  if (member === null || member.revokedAt !== null || !isPlatformRole(member.role)) {
    throw new PlatformAccessDeniedError();
  }
  const context = Object.freeze({
    platformMemberId: member.id,
    userId: toUserId(userId),
    role: member.role,
  }) as PlatformContext;
  issuedPlatformContexts.add(context);
  return context;
}

/**
 * The staff member this context belongs to, rejecting one that did not come from authorization.
 *
 * The platform equivalent of `scopeOf`, and the same assertion for the same reason: a structurally
 * identical object assembled anywhere else is refused, so "a platform context" means "this process read a
 * platform role from the database during this request".
 */
export function platformActorOf(context: PlatformContext): { readonly platformMemberId: string; readonly userId: UserId; readonly role: PlatformRole } {
  if (typeof context !== "object" || context === null || !issuedPlatformContexts.has(context)) {
    throw new PlatformAccessDeniedError();
  }
  return { platformMemberId: context.platformMemberId, userId: context.userId, role: context.role };
}

/**
 * Refuses an operator who does not hold a permission.
 *
 * The context is validated first, so a forged object is refused as unauthorized rather than examined for
 * a role it claims to have. Named by the act — "pull a kill switch" — because the same act reaches the
 * console from more than one place and a check tied to a screen is a check the second screen forgets.
 */
export function requirePlatformPermission(context: PlatformContext, permission: PlatformPermission, action: string): void {
  const actor = platformActorOf(context);
  if (!platformPermitted(actor.role, permission)) {
    throw new PlatformPermissionError(actor.role, permission, action);
  }
}

/** Whether this operator holds a permission, for a screen deciding what to *offer*. Never a gate. */
export function platformCan(context: PlatformContext, permission: PlatformPermission): boolean {
  return platformPermitted(platformActorOf(context).role, permission);
}
