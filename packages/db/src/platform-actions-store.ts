/**
 * The two things an operator can *do* from the console in this slice (#59, ADMIN_OPERATIONS.md).
 *
 * The issue's acceptance criterion is a capability — "routine commercial troubleshooting can be performed
 * without direct DB mutation" — so a console that only read would satisfy none of it. These are the two
 * paths the codebase currently documents as direct production SQL:
 *
 * - **Pulling and lifting the automated-outbound kill switch.** `suspension-store.ts` says in its own
 *   comments that the documented way to pull it today is an operator running SQL during an incident. That
 *   is safe to replace, because the ordering guarantee is a `BEFORE INSERT/UPDATE/DELETE` trigger on the
 *   table rather than anything in application code — so a console write is ordered against delivery
 *   claims exactly as hand-written SQL is.
 * - **Asking the system to re-examine an ambiguous operation.** Reachable only from the worker's queue
 *   handler until now.
 *
 * Two rules that are not negotiable here.
 *
 * **There is no resend, and no generic retry.** Re-examination records that a person asked for it and
 * nothing else; the decision belongs to `reconcileOperation` in `packages/application`, which the web
 * composition root calls with its stores. This module deliberately cannot reach it — `packages/db` may not
 * import `packages/application` — which is why the action here writes the request and the audit row, and
 * the caller performs the reconciliation. A "retry anyway" control for an ambiguous non-idempotent write
 * is the one thing `ADMIN_OPERATIONS.md` names as forbidden.
 *
 * **Every change is attributable.** A kill switch pulled by a person carries that person, enforced by
 * `automation_suspensions_operator_check` as well as here — and that CHECK is load-bearing rather than
 * tidy, because `activeSystemSuspension` identifies the system's own switch precisely by the actor being
 * absent. An operator pause with no actor would be one the backlog guard could close.
 */
import { createAutomationSuspension, type SuspensionReason, type SuspensionScope } from "@omnichannel/domain";

import type { DbClient } from "./client";
import { DbInputError } from "./errors";
import { recordPlatformAuditEvent } from "./platform-audit-store";
import { platformActorOf, requirePlatformPermission, type PlatformContext } from "./platform-tenancy";

export interface PullKillSwitchInput {
  readonly scope: SuspensionScope;
  readonly workspaceId?: string;
  readonly businessProfileId?: string;
  readonly channelAccountId?: string;
  /** Why, in the operator's words. Required, and written to both the switch and the audit row. */
  readonly reason: string;
  /** When it should lapse on its own. Absent means it stays until somebody lifts it. */
  readonly until?: Date;
  readonly at?: Date;
}

export interface PulledKillSwitch {
  readonly suspensionId: string;
  readonly scope: SuspensionScope;
}

/**
 * Pulls an automated-outbound kill switch at one of the four scopes that exist.
 *
 * The scope's identifiers are validated by the domain's own constructor before anything is written,
 * because a `BUSINESS_PROFILE` switch with no profile named is a global stop wearing a narrow label —
 * the most dangerous shape this type can take, since it looks contained and is not.
 *
 * `reason` is always `OPERATOR`: a person pulling the switch is the one reason that needs no further
 * classification, and the three machine reasons belong to the machinery that raises them. The operator's
 * own words go in the note and in the audit row.
 *
 * Inbound ingestion is untouched, which is the domain's property rather than this function's: nothing
 * about a suspension is consulted on the inbound path.
 */
export async function pullKillSwitch(db: DbClient, context: PlatformContext, input: PullKillSwitchInput): Promise<PulledKillSwitch> {
  requirePlatformPermission(context, "OPERATE_KILL_SWITCH", "pull an automated-outbound kill switch");
  const actor = platformActorOf(context);
  const at = input.at ?? new Date();
  if (input.reason.trim() === "") {
    throw new DbInputError("reason", "a kill switch nobody can explain is one nobody dares lift");
  }
  const reason: SuspensionReason = "OPERATOR";
  // Refuses a scope whose identifiers disagree with it, before the row exists.
  createAutomationSuspension({
    scope: input.scope,
    ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId as never }),
    ...(input.businessProfileId === undefined ? {} : { businessProfileId: input.businessProfileId as never }),
    ...(input.channelAccountId === undefined ? {} : { channelAccountId: input.channelAccountId as never }),
    reason,
    note: input.reason,
    since: at,
    ...(input.until === undefined ? {} : { until: input.until }),
    byUserId: actor.userId,
  });

  return db.$transaction(async (tx) => {
    const created = await tx.automationSuspension.create({
      data: {
        scope: input.scope,
        workspaceId: input.workspaceId ?? null,
        businessProfileId: input.businessProfileId ?? null,
        channelAccountId: input.channelAccountId ?? null,
        reason,
        note: input.reason.trim(),
        since: at,
        until: input.until ?? null,
        // The actor, and the CHECK refuses the row without one. This is what keeps the backlog guard out
        // of an operator's switch.
        byUserId: actor.userId,
      },
      select: { id: true },
    });
    await recordPlatformAuditEvent(tx, context, {
      kind: "KILL_SWITCH_PULLED",
      subjectType: "AutomationSuspension",
      subjectId: created.id,
      reason: input.reason,
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      ...(input.businessProfileId === undefined ? {} : { businessProfileId: input.businessProfileId }),
      detail: {
        scope: input.scope,
        ...(input.channelAccountId === undefined ? {} : { channelAccountId: input.channelAccountId }),
        ...(input.until === undefined ? {} : { until: input.until.toISOString() }),
      },
      occurredAt: at,
    });
    return { suspensionId: created.id, scope: input.scope };
  });
}

/**
 * Lifts a switch a person pulled.
 *
 * Only an unlifted one, so a second click does not rewrite who lifted it first — and only one with an
 * actor, which is to say not the system's own. An operator ending the system's backpressure pause from a
 * console would be the console overruling the machinery that is protecting the queue, and the right way
 * to do that is to fix the backlog.
 *
 * Idempotent: lifting an already-lifted switch reports `false` and writes no second audit row, because
 * the audit should say what happened and nothing happened.
 */
export async function liftKillSwitch(
  db: DbClient,
  context: PlatformContext,
  input: { readonly suspensionId: string; readonly reason: string; readonly at?: Date },
): Promise<{ readonly lifted: boolean }> {
  requirePlatformPermission(context, "OPERATE_KILL_SWITCH", "lift an automated-outbound kill switch");
  const actor = platformActorOf(context);
  const at = input.at ?? new Date();
  if (input.reason.trim() === "") {
    throw new DbInputError("reason", "lifting a kill switch records why it is now safe");
  }

  return db.$transaction(async (tx) => {
    const suspension = await tx.automationSuspension.findUnique({
      where: { id: input.suspensionId },
      select: { scope: true, workspaceId: true, businessProfileId: true, liftedAt: true, byUserId: true },
    });
    if (suspension === null) {
      throw new DbInputError("suspensionId", "no such suspension");
    }
    if (suspension.byUserId === null) {
      throw new DbInputError("suspensionId", "this is the system's own pause; it ends when the condition that raised it does");
    }
    if (suspension.liftedAt !== null) {
      return { lifted: false };
    }
    // The count decides, not the read above. Two operators can both pass the `liftedAt !== null` check
    // before either writes: the predicate makes sure only one of them changes the row, but ignoring the
    // count made the loser report a lift it did not perform and file an audit row claiming a second state
    // transition that never happened. The winner's attribution was never at risk; the record was.
    const { count } = await tx.automationSuspension.updateMany({
      where: { id: input.suspensionId, liftedAt: null },
      data: { liftedAt: at, liftedByUserId: actor.userId },
    });
    if (count === 0) {
      // Somebody else lifted it between the read and the update. Same answer as finding it already
      // lifted, and deliberately no transition event: there was no transition.
      return { lifted: false };
    }
    await recordPlatformAuditEvent(tx, context, {
      kind: "KILL_SWITCH_LIFTED",
      subjectType: "AutomationSuspension",
      subjectId: input.suspensionId,
      reason: input.reason,
      ...(suspension.workspaceId === null ? {} : { workspaceId: suspension.workspaceId }),
      ...(suspension.businessProfileId === null ? {} : { businessProfileId: suspension.businessProfileId }),
      detail: { scope: suspension.scope },
      occurredAt: at,
    });
    return { lifted: true };
  });
}

/** Every operator-pulled switch still in force, so a console can offer the one to lift. */
export interface KillSwitchRow {
  readonly suspensionId: string;
  readonly scope: SuspensionScope;
  readonly workspaceId: string | null;
  readonly businessProfileId: string | null;
  readonly channelAccountId: string | null;
  readonly reason: SuspensionReason;
  readonly note: string | null;
  readonly since: Date;
  readonly until: Date | null;
  readonly byOperator: boolean;
}

export async function listKillSwitches(
  db: DbClient,
  context: PlatformContext,
  query: { readonly workspaceId?: string; readonly at?: Date } = {},
): Promise<readonly KillSwitchRow[]> {
  requirePlatformPermission(context, "READ_METADATA", "list kill switches");
  const at = query.at ?? new Date();
  const rows = await db.automationSuspension.findMany({
    where: {
      liftedAt: null,
      since: { lte: at },
      // `AND` of two disjunctions, not two `OR` keys. Two bare `OR`s in one object literal is the second
      // silently replacing the first — so with a workspace supplied, which is what the workspace screen
      // always does, the expiry half was dropped and a switch whose `until` had already passed was listed
      // as active, while the unfiltered home list excluded it correctly. An incident console reading
      // "outbound is stopped" while it is not is the wrong direction to be wrong in, and expired rows
      // could also consume the 100-row cap and hide switches that really were active.
      //
      // Both sides of this merge had already made this exact repair independently, with identical code:
      // it was found here while writing P7-02 and found again on P7-01 under review. `inbox-store.ts`
      // documents the same trap and defends against it the same way, which is where the shape comes from.
      AND: [
        { OR: [{ until: null }, { until: { gt: at } }] },
        ...(query.workspaceId === undefined ? [] : [{ OR: [{ scope: "GLOBAL" as const }, { workspaceId: query.workspaceId }] }]),
      ],
    },
    orderBy: [{ since: "desc" }],
    take: 100,
    select: {
      id: true,
      scope: true,
      workspaceId: true,
      businessProfileId: true,
      channelAccountId: true,
      reason: true,
      note: true,
      since: true,
      until: true,
      byUserId: true,
    },
  });
  return rows.map((row) => ({
    suspensionId: row.id,
    scope: row.scope,
    workspaceId: row.workspaceId,
    businessProfileId: row.businessProfileId,
    channelAccountId: row.channelAccountId,
    reason: row.reason,
    note: row.note,
    since: row.since,
    until: row.until,
    byOperator: row.byUserId !== null,
  }));
}

/**
 * Records that an operator asked for an ambiguous operation to be re-examined.
 *
 * Deliberately only the record. The decision is `reconcileOperation`'s, in `packages/application`, which
 * this package may not import — and that boundary is doing real work here: it makes it impossible for
 * this function to grow a shortcut that marks the operation resolved, or worse, resends. The caller runs
 * the reconciliation; this says who asked and why.
 *
 * Refuses an operation that is already concluded, because re-examining a settled send is how a duplicate
 * gets sent.
 */
export async function requestReconciliation(
  db: DbClient,
  context: PlatformContext,
  input: { readonly operationId: string; readonly reason: string; readonly at?: Date },
): Promise<{
  readonly workspaceId: string;
  readonly businessProfileId: string;
  readonly conversationId: string;
  readonly deliveryJobId: string;
  readonly reason: "AMBIGUOUS_SEND_RESULT" | "DELIVERY_HANDLER_FAILED" | "DELIVERY_STALLED";
  readonly detectedAt: Date;
  readonly providerRequestId: string | null;
  readonly providerCode: string | null;
  /** The delivery's own correlation id, so a re-examination joins the original operation's trace. */
  readonly correlationId: string;
  readonly state: string;
}> {
  requirePlatformPermission(context, "OPERATE_RECONCILIATION", "ask for an ambiguous operation to be re-examined");
  const at = input.at ?? new Date();
  if (input.reason.trim() === "") {
    throw new DbInputError("reason", "re-examination records who asked and why");
  }

  return db.$transaction(async (tx) => {
    // Everything the queue job needs, so the caller does not have to re-read the row it just validated —
    // and so the identity it enqueues is the one this function checked rather than a later snapshot.
    const record = await tx.deliveryReconciliation.findUnique({
      where: { operationId: input.operationId },
      select: {
        workspaceId: true,
        businessProfileId: true,
        conversationId: true,
        deliveryJobId: true,
        reason: true,
        detectedAt: true,
        providerRequestId: true,
        providerCode: true,
        state: true,
        resolvedAt: true,
        deliveryJob: { select: { correlationId: true } },
      },
    });
    if (record === null) {
      throw new DbInputError("operationId", "no ambiguous operation with that identity");
    }
    if (record.resolvedAt !== null) {
      throw new DbInputError("operationId", "that operation is already concluded; re-examining a settled send is how a duplicate is sent");
    }
    await recordPlatformAuditEvent(tx, context, {
      kind: "RECONCILIATION_REQUESTED",
      subjectType: "DeliveryReconciliation",
      subjectId: input.operationId,
      reason: input.reason,
      workspaceId: record.workspaceId,
      businessProfileId: record.businessProfileId,
      detail: { stateBefore: record.state },
      occurredAt: at,
    });
    return {
      workspaceId: record.workspaceId,
      businessProfileId: record.businessProfileId,
      conversationId: record.conversationId,
      deliveryJobId: record.deliveryJobId,
      reason: record.reason,
      detectedAt: record.detectedAt,
      providerRequestId: record.providerRequestId,
      providerCode: record.providerCode,
      correlationId: record.deliveryJob.correlationId,
      state: record.state,
    };
  });
}
