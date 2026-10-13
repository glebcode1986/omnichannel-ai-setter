/**
 * What is paused right now, asked once (Issue #56, and a sweep that found four answers to it).
 *
 * A kill switch is read on five paths — the delivery claim, the follow-up scheduler, onboarding
 * readiness, the operator snapshot and the suspension store's own reader — and each had written its own
 * `where` clause. They did not agree, and the disagreements were exactly the ones a hand-written
 * predicate produces:
 *
 * - **the follow-up scheduler omitted `GLOBAL` entirely.** Its `OR` listed `WORKSPACE`,
 *   `BUSINESS_PROFILE` and `CHANNEL_ACCOUNT`, so the platform-wide stop — the one an operator pulls when
 *   something is wrong and they do not yet know what — did not cover follow-ups. A scheduled follow-up is
 *   automated outbound, and it would have gone out;
 * - **two of them ignored the window**, so a switch that had expired on its own clock, or one scheduled
 *   to start later, read as in force for ever. That direction is safe for a send and wrong for a screen:
 *   onboarding told a business its outbound was suspended with nothing an operator could lift.
 *
 * So the predicate lives here, once, and the *judgement* stays in the domain: `activeSuspension` decides
 * which of several applies — widest first, and an expired or not-yet-started one covers nothing. This
 * module is deliberately only the read. Nothing here decides whether a send may proceed.
 *
 * It takes a `DbExecutor` rather than a client because the delivery claim calls it inside its own
 * transaction, after taking the key that orders it against a switch being pulled. That was the original
 * reason for the second copy, and it is one parameter rather than a second implementation.
 */
import {
  activeSuspension,
  toBusinessProfileId,
  toChannelAccountId,
  toUserId,
  toWorkspaceId,
  type AutomationSuspension,
} from "@omnichannel/domain";

import type { DbExecutor } from "./client";

/**
 * Which target to find the switches for.
 *
 * `businessProfileId` and `channelAccountId` are optional, and absent means *any* rather than none:
 * onboarding asks "which of this profile's accounts are paused" and the operator snapshot asks "is
 * anything in this workspace paused", and both need the narrow scopes without naming one row. Present,
 * they narrow to that row — which is what the delivery claim and the follow-up scheduler want.
 */
export interface CoveringTarget {
  readonly workspaceId: string;
  readonly businessProfileId?: string;
  readonly channelAccountId?: string;
}

/**
 * Every unlifted switch that could cover this target, as domain values.
 *
 * "Could" rather than "does": the window is the domain's to judge, and returning only the ones in force
 * would make this function a second place where the clock rule lives.
 */
export async function loadCoveringSuspensions(db: DbExecutor, target: CoveringTarget): Promise<readonly AutomationSuspension[]> {
  const rows = await db.automationSuspension.findMany({
    where: {
      liftedAt: null,
      OR: [
        // Always. This is the arm the follow-up scheduler was missing, and the one that matters most.
        { scope: "GLOBAL" },
        { scope: "WORKSPACE", workspaceId: target.workspaceId },
        {
          scope: "BUSINESS_PROFILE",
          workspaceId: target.workspaceId,
          ...(target.businessProfileId === undefined ? {} : { businessProfileId: target.businessProfileId }),
        },
        {
          scope: "CHANNEL_ACCOUNT",
          workspaceId: target.workspaceId,
          ...(target.channelAccountId === undefined ? {} : { channelAccountId: target.channelAccountId }),
        },
      ],
    },
    select: {
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
  return rows.map(
    (row): AutomationSuspension => ({
      scope: row.scope,
      ...(row.workspaceId === null ? {} : { workspaceId: toWorkspaceId(row.workspaceId) }),
      ...(row.businessProfileId === null ? {} : { businessProfileId: toBusinessProfileId(row.businessProfileId) }),
      ...(row.channelAccountId === null ? {} : { channelAccountId: toChannelAccountId(row.channelAccountId) }),
      reason: row.reason,
      ...(row.note === null ? {} : { note: row.note }),
      since: row.since,
      ...(row.until === null ? {} : { until: row.until }),
      ...(row.byUserId === null ? {} : { byUserId: toUserId(row.byUserId) }),
    }),
  );
}

/**
 * The switch covering one exact target at one instant, or nothing.
 *
 * The shape every send path wants: one target, one answer, the domain's precedence. `at` is a parameter
 * rather than the wall clock because the claim re-resolves at the instant it is deciding about, and a
 * switch read at a different moment from the rest of the guard is a guard describing two moments.
 */
export async function coveringSuspensionAt(
  db: DbExecutor,
  target: { readonly workspaceId: string; readonly businessProfileId: string; readonly channelAccountId: string },
  at: Date,
): Promise<AutomationSuspension | undefined> {
  const suspensions = await loadCoveringSuspensions(db, target);
  return activeSuspension(
    {
      workspaceId: toWorkspaceId(target.workspaceId),
      businessProfileId: toBusinessProfileId(target.businessProfileId),
      channelAccountId: toChannelAccountId(target.channelAccountId),
    },
    suspensions,
    at,
  );
}
