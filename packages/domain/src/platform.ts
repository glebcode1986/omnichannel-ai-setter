/**
 * The internal control plane's own vocabulary (#59, ADMIN_OPERATIONS.md).
 *
 * This file exists to keep two authorization domains apart. A customer's `OWNER` runs their own business;
 * a platform `SUPPORT` engineer runs ours. Neither grants anything in the other's world, and the single
 * most dangerous thing this codebase could do is let one object stand for both — so the roles are a
 * separate list, the permissions are a separate list, and the context that carries them (in
 * `packages/db/src/platform-tenancy.ts`) has its own brand, which `scopeOf` rejects.
 *
 * Three things are deliberately *data* here rather than conditionals spread through the code:
 *
 * **The role-to-permission matrix.** Issue #59 names four roles and exactly one hard rule — "support
 * metadata access must not automatically include conversation-content access or billing mutation". The
 * rest is policy the product owner has not written down, so it is written once, in one table, with the
 * reasoning beside each row. Changing it is editing a literal, not auditing call sites.
 *
 * **What a support session may unlock.** Metadata is the default and needs no session at all. Reading a
 * customer's correspondence needs an explicit, scoped, time-limited session, and that is computed from
 * the session plus a clock rather than stored, so an expired session cannot be mistaken for a live one by
 * a row that nobody re-read.
 *
 * **What severity an operator action has.** Derived from the kind, exactly as the customer audit derives
 * `sensitive` from the kind: a caller that could choose would eventually file a break-glass grant as
 * routine, in a hurry, and the one record an incident review reads most carefully would be wrong.
 *
 * Nothing here reads a clock, a database or a provider.
 */
import { literalGuard } from "./enum";
import { DomainValidationError } from "./errors";

/**
 * The internal roles, from `ADMIN_OPERATIONS.md`.
 *
 * Not the customer's `OWNER` / `ADMIN` / `AGENT`, and never stored in the same column. A platform member
 * is not a member of anybody's workspace, which is also why they appear in no seat count and in no
 * workspace list.
 */
export const PLATFORM_ROLES = ["SUPPORT", "BILLING", "OPERATIONS", "PLATFORM_ADMIN"] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];
export const isPlatformRole = literalGuard(PLATFORM_ROLES);

/**
 * What an internal operator may do, as named capabilities rather than as route names.
 *
 * Named by the *act*, not by the screen, because the same act reaches the console from more than one
 * place and a permission tied to a page is a permission a second page forgets to check.
 */
export const PLATFORM_PERMISSIONS = [
  /** Look a workspace up and read its operational metadata. The floor: every role has this. */
  "READ_METADATA",
  /** Read the commercial state: plan, subscription lifecycle, allowance, usage. */
  "READ_BILLING",
  /** Change commercial state — an override, a top-up, a trial extension. Not in this slice's actions. */
  "WRITE_BILLING",
  /** Open a support access session, which is what can unlock a customer's correspondence. */
  "OPEN_SUPPORT_SESSION",
  /** Open a break-glass session: the same unlock, with a reason, a short clock and a CRITICAL audit row. */
  "BREAK_GLASS",
  /** Pull or lift an automated-outbound kill switch. */
  "OPERATE_KILL_SWITCH",
  /** Ask the system to re-examine an ambiguous operation. Never a resend; see `reconcileOperation`. */
  "OPERATE_RECONCILIATION",
  /** Read the internal audit log. */
  "READ_PLATFORM_AUDIT",
  /** Grant or remove a platform role. */
  "MANAGE_PLATFORM_MEMBERS",
  /**
   * Record a release candidate, file a reviewer's verdict, or change the limited-rollout allowlist (#60).
   *
   * One permission for all three because they are one decision taken in instalments: the candidate
   * proposes a stage, the verdict is what makes it count, and the allowlist is who it applies to. Holding
   * one without the others would let somebody move the §18 stage in force while being unable to see or
   * say who it reaches.
   */
  "OPERATE_RELEASE",
] as const;
export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];
export const isPlatformPermission = literalGuard(PLATFORM_PERMISSIONS);

/**
 * The matrix. **This is policy, and the product owner's to change** (#59 names the roles and one rule).
 *
 * What is defensible about each row, so that a later reader can argue with it rather than guess at it:
 *
 * - `SUPPORT` diagnoses. It may read metadata, read commercial state because "why was this customer
 *   refused?" is a support question, and open an ordinary support session — the issue's one explicit rule
 *   is that this does *not* carry conversation content automatically, and it does not: the session grants
 *   that, scoped and expiring, and `BREAK_GLASS` is a separate permission it does not have.
 * - `BILLING` works on money. It reads and changes commercial state and reads the audit, and it has no
 *   support session at all: nothing about an invoice requires reading somebody's correspondence.
 * - `OPERATIONS` works on incidents. Kill switches and reconciliation, plus sessions because diagnosing a
 *   stuck send sometimes means reading the thread it is stuck in. No billing mutation.
 * - `PLATFORM_ADMIN` administers the platform, which is a narrow job: it manages roles and holds
 *   break-glass. It is deliberately **not** a superset — it cannot change billing, because "the person
 *   who grants roles" and "the person who moves money" being the same person is the control this
 *   separation exists to provide.
 * - `OPERATE_RELEASE` goes to `OPERATIONS` and `PLATFORM_ADMIN`, the two that already hold
 *   `OPERATE_KILL_SWITCH`, because a release decision and a kill switch move the same gate in opposite
 *   directions and it would be incoherent for one role to be trusted to stop unattended sending and not
 *   to be trusted to see or state the rollout that started it. `BILLING` and `SUPPORT` do not have it:
 *   neither an invoice nor a diagnosis is a reason to advance a rollout.
 */
export const PLATFORM_PERMISSION_MATRIX: Readonly<Record<PlatformRole, readonly PlatformPermission[]>> = {
  SUPPORT: ["READ_METADATA", "READ_BILLING", "OPEN_SUPPORT_SESSION", "READ_PLATFORM_AUDIT"],
  BILLING: ["READ_METADATA", "READ_BILLING", "WRITE_BILLING", "READ_PLATFORM_AUDIT"],
  OPERATIONS: [
    "READ_METADATA",
    "READ_BILLING",
    "OPEN_SUPPORT_SESSION",
    "OPERATE_KILL_SWITCH",
    "OPERATE_RECONCILIATION",
    "OPERATE_RELEASE",
    "READ_PLATFORM_AUDIT",
  ],
  PLATFORM_ADMIN: [
    "READ_METADATA",
    "OPEN_SUPPORT_SESSION",
    "BREAK_GLASS",
    "OPERATE_KILL_SWITCH",
    "OPERATE_RELEASE",
    "READ_PLATFORM_AUDIT",
    "MANAGE_PLATFORM_MEMBERS",
  ],
};

/** Whether this role holds this permission. The only reader of the matrix. */
export function platformPermitted(role: PlatformRole, permission: PlatformPermission): boolean {
  return PLATFORM_PERMISSION_MATRIX[role].includes(permission);
}

/**
 * What a support session can unlock beyond metadata.
 *
 * `METADATA` is not in this list on purpose. Metadata is what an operator sees without any session, so a
 * scope granting it would be a scope that changes nothing — and a session that appeared to grant
 * something while granting nothing is worse than no session at all.
 */
export const SUPPORT_DATA_SCOPES = [
  /** A customer's own message text, draft text and transcripts. The thing a session exists to gate. */
  "CONVERSATION_CONTENT",
  /** Provider-side commercial references and invoice detail, beyond the normalized plan state. */
  "BILLING_DETAIL",
] as const;
export type SupportDataScope = (typeof SUPPORT_DATA_SCOPES)[number];
export const isSupportDataScope = literalGuard(SUPPORT_DATA_SCOPES);

/**
 * The longest a break-glass session may last.
 *
 * Fifteen minutes, enforced as a CHECK on the row rather than as a default in a caller, because a
 * maximum a caller could widen is not a maximum. It is short enough that an operator has to come back and
 * say why again, which is the point: break-glass is for the minutes during an incident when waiting for
 * an ordinary session would cost more than the access does.
 */
export const BREAK_GLASS_MAX_MS = 15 * 60 * 1000;

/** The longest an ordinary support session may last. A working session, not a standing grant. */
export const SUPPORT_SESSION_MAX_MS = 8 * 60 * 60 * 1000;

/** A stored session, as the domain sees it. No actor name, no ticket text: those are for the audit. */
export interface SupportAccessSession {
  readonly sessionId: string;
  readonly workspaceId: string;
  /** Present when the session was scoped to one Business Profile rather than the whole workspace. */
  readonly businessProfileId?: string;
  readonly scopes: readonly SupportDataScope[];
  readonly breakGlass: boolean;
  readonly startedAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt?: Date;
}

/** Why a session grants nothing. Reported rather than folded into a boolean, so a screen can say which. */
export const SUPPORT_SCOPE_REFUSALS = ["NO_SESSION", "EXPIRED", "REVOKED", "OUT_OF_SCOPE"] as const;
export type SupportScopeRefusal = (typeof SUPPORT_SCOPE_REFUSALS)[number];

/**
 * What an operator may read right now, for one workspace and profile.
 *
 * Deliberately a value rather than a method on a session: it is derived from the session **and a clock**,
 * at the moment of the read, so there is no way to hold a scope that was true an hour ago. The module
 * comment in `support-access-store.ts` says the same thing `tenancy.ts` says about membership — the
 * answer is re-derived per request, and a revocation landing mid-request is not seen by that request.
 */
export interface SupportScope {
  readonly workspaceId: string;
  readonly businessProfileId?: string;
  readonly granted: readonly SupportDataScope[];
  /** Present when nothing is granted, saying why. */
  readonly refusal?: SupportScopeRefusal;
  readonly sessionId?: string;
  readonly breakGlass: boolean;
}

/** A scope that unlocks nothing. Named rather than written out, so "no session" and "expired" agree. */
export function noSupportScope(workspaceId: string, refusal: SupportScopeRefusal, businessProfileId?: string): SupportScope {
  return {
    workspaceId,
    ...(businessProfileId === undefined ? {} : { businessProfileId }),
    granted: [],
    refusal,
    breakGlass: false,
  };
}

/**
 * Derives what one session grants for one target, at one instant.
 *
 * Four refusals and they are different facts: there was no session; there was one and its clock ran out;
 * somebody revoked it; it was for another workspace or another profile. A screen that could only say
 * "denied" would send an operator to re-request access they already have for the wrong tenant.
 *
 * A workspace-wide session covers any profile in it. A profile-scoped one covers only that profile, and
 * covers a request that names no profile not at all — because "the whole workspace" is strictly more than
 * the session granted.
 */
export function supportScopeOf(
  session: SupportAccessSession | undefined,
  target: { readonly workspaceId: string; readonly businessProfileId?: string },
  at: Date,
): SupportScope {
  if (session === undefined) {
    return noSupportScope(target.workspaceId, "NO_SESSION", target.businessProfileId);
  }
  if (session.revokedAt !== undefined && session.revokedAt.getTime() <= at.getTime()) {
    return noSupportScope(target.workspaceId, "REVOKED", target.businessProfileId);
  }
  if (session.expiresAt.getTime() <= at.getTime() || session.startedAt.getTime() > at.getTime()) {
    return noSupportScope(target.workspaceId, "EXPIRED", target.businessProfileId);
  }
  const sameWorkspace = session.workspaceId === target.workspaceId;
  const profileCovered =
    session.businessProfileId === undefined
      ? true
      : target.businessProfileId !== undefined && session.businessProfileId === target.businessProfileId;
  if (!sameWorkspace || !profileCovered) {
    return noSupportScope(target.workspaceId, "OUT_OF_SCOPE", target.businessProfileId);
  }
  return {
    workspaceId: target.workspaceId,
    ...(target.businessProfileId === undefined ? {} : { businessProfileId: target.businessProfileId }),
    granted: SUPPORT_DATA_SCOPES.filter((scope) => session.scopes.includes(scope)),
    sessionId: session.sessionId,
    breakGlass: session.breakGlass,
  };
}

/** Whether this scope unlocks that data. The only question a content-bearing read should ask. */
export function supportScopeGrants(scope: SupportScope, data: SupportDataScope): boolean {
  return scope.granted.includes(data);
}

/**
 * Validates a session somebody is asking for, before it is written.
 *
 * The clock is the part worth refusing early: a break-glass session longer than fifteen minutes, or any
 * session that expires before it starts, is a request nobody should have to discover from a constraint
 * violation. Both are also CHECKs, because this function is not the only way a row could be written.
 */
export function validateSupportSessionRequest(input: {
  readonly scopes: readonly SupportDataScope[];
  readonly reason: string;
  readonly breakGlass: boolean;
  readonly startedAt: Date;
  readonly expiresAt: Date;
}): void {
  if (input.scopes.length === 0) {
    throw new DomainValidationError("scopes", "a session that grants nothing is not a session; metadata needs none");
  }
  const unknown = input.scopes.filter((scope) => !isSupportDataScope(scope));
  if (unknown.length > 0) {
    throw new DomainValidationError("scopes", `not support data scopes: ${unknown.join(", ")}`);
  }
  if (input.reason.trim() === "") {
    throw new DomainValidationError("reason", "access nobody can explain is access nobody dares revoke");
  }
  const duration = input.expiresAt.getTime() - input.startedAt.getTime();
  if (duration <= 0) {
    throw new DomainValidationError("expiresAt", "a session ends after it begins");
  }
  const maximum = input.breakGlass ? BREAK_GLASS_MAX_MS : SUPPORT_SESSION_MAX_MS;
  if (duration > maximum) {
    throw new DomainValidationError("expiresAt", `a ${input.breakGlass ? "break-glass" : "support"} session lasts at most ${String(maximum / 60_000)} minutes`);
  }
}

/**
 * What the internal audit records.
 *
 * A closed list, like the customer audit's, and for the same reason: a search can offer the kinds that
 * exist, and a reader can tell "nothing happened" from "somebody filed it under a name I did not guess".
 * These are *operator* actions — a customer never appears here as an actor.
 */
export const PLATFORM_AUDIT_KINDS = [
  /** A platform role was granted or removed. */
  "PLATFORM_MEMBER_CHANGED",
  /** An operator looked a workspace up. Recorded because cross-tenant lookup is itself the privilege. */
  "WORKSPACE_INSPECTED",
  /** An ordinary support access session was opened. */
  "SUPPORT_SESSION_OPENED",
  "SUPPORT_SESSION_REVOKED",
  /** A break-glass session was opened. Always CRITICAL. */
  "BREAK_GLASS_OPENED",
  /** A customer's correspondence was read under a session. The act, not the session, is the event. */
  "CUSTOMER_CONTENT_READ",
  /** An automated-outbound kill switch was pulled or lifted by a person. */
  "KILL_SWITCH_PULLED",
  "KILL_SWITCH_LIFTED",
  /** An operator asked the system to re-examine an ambiguous operation. Never a resend. */
  "RECONCILIATION_REQUESTED",
  /** A release candidate was recorded with its gate verdicts. What can move the §18 stage in force. */
  "RELEASE_RECORDED",
  /** An independent reviewer's verdict was filed against a commit. */
  "RELEASE_REVIEW_RECORDED",
  /** A Business Profile was added to or removed from the limited-rollout autopilot allowlist. */
  "ROLLOUT_ALLOWLIST_CHANGED",
] as const;
export type PlatformAuditKind = (typeof PLATFORM_AUDIT_KINDS)[number];
export const isPlatformAuditKind = literalGuard(PLATFORM_AUDIT_KINDS);

export const PLATFORM_AUDIT_SEVERITIES = ["INFO", "WARNING", "CRITICAL"] as const;
export type PlatformAuditSeverity = (typeof PLATFORM_AUDIT_SEVERITIES)[number];

/**
 * How serious each kind is, derived and not passed in.
 *
 * The customer audit derives `sensitive` from the kind for a stated reason — a caller that could choose
 * would eventually file a role change as ordinary work, by accident, in a hurry — and the same reasoning
 * applies with more force here, because the row this would get wrong is the one an incident review reads
 * first.
 *
 * `CRITICAL` is reserved for the two acts that are indistinguishable from an attack if nobody authorised
 * them: breaking the glass, and reading a customer's correspondence. A kill switch is `WARNING` because
 * it is a deliberate, visible, reversible act that stops the product doing something — serious, and not
 * the same kind of serious.
 */
const SEVERITIES: Readonly<Record<PlatformAuditKind, PlatformAuditSeverity>> = {
  PLATFORM_MEMBER_CHANGED: "WARNING",
  WORKSPACE_INSPECTED: "INFO",
  SUPPORT_SESSION_OPENED: "WARNING",
  SUPPORT_SESSION_REVOKED: "INFO",
  BREAK_GLASS_OPENED: "CRITICAL",
  CUSTOMER_CONTENT_READ: "CRITICAL",
  KILL_SWITCH_PULLED: "WARNING",
  KILL_SWITCH_LIFTED: "WARNING",
  RECONCILIATION_REQUESTED: "INFO",
  // `WARNING` for the kill switch's reason read the other way round: a switch is a deliberate, visible,
  // reversible act that stops the product doing something, and these two are deliberate, visible acts
  // that can *start* it — they are what moves the §18 stage, and therefore what can permit unattended
  // sending. Filing a verdict is `INFO` because it changes no permission on its own: a `PASS` matters
  // only together with gates that already permit a release, and a `CHANGES_REQUESTED` only subtracts.
  RELEASE_RECORDED: "WARNING",
  RELEASE_REVIEW_RECORDED: "INFO",
  ROLLOUT_ALLOWLIST_CHANGED: "WARNING",
};

export function platformAuditSeverity(kind: PlatformAuditKind): PlatformAuditSeverity {
  return SEVERITIES[kind];
}

/** Which permission each operator action requires. One table, so a new action cannot forget to need one. */
export const PLATFORM_ACTION_PERMISSIONS: Readonly<Record<PlatformAuditKind, PlatformPermission>> = {
  PLATFORM_MEMBER_CHANGED: "MANAGE_PLATFORM_MEMBERS",
  WORKSPACE_INSPECTED: "READ_METADATA",
  SUPPORT_SESSION_OPENED: "OPEN_SUPPORT_SESSION",
  SUPPORT_SESSION_REVOKED: "OPEN_SUPPORT_SESSION",
  BREAK_GLASS_OPENED: "BREAK_GLASS",
  CUSTOMER_CONTENT_READ: "OPEN_SUPPORT_SESSION",
  KILL_SWITCH_PULLED: "OPERATE_KILL_SWITCH",
  KILL_SWITCH_LIFTED: "OPERATE_KILL_SWITCH",
  RECONCILIATION_REQUESTED: "OPERATE_RECONCILIATION",
  RELEASE_RECORDED: "OPERATE_RELEASE",
  RELEASE_REVIEW_RECORDED: "OPERATE_RELEASE",
  ROLLOUT_ALLOWLIST_CHANGED: "OPERATE_RELEASE",
};
