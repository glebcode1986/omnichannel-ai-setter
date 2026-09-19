/**
 * Reading and writing the automated-outbound kill switch (Issue #56).
 *
 * Loading is deliberately generous: every live suspension that could possibly cover this target, decided
 * in the database by scope, and then narrowed by the domain function that knows the nesting rules. Two
 * places knowing "widest wins" is exactly how a switch ends up honoured in one path and ignored in another.
 *
 * Lifting never deletes. The question after an incident is always who turned this off and whether anyone
 * turned it back on, and a deleted row cannot answer either half.
 */
import type { AutomationSuspension, SuspensionReason, SuspensionScope } from "@omnichannel/domain";

import type { DbClient } from "./client";

export interface SuspensionTargetQuery {
  readonly workspaceId: string;
  readonly businessProfileId: string;
  readonly channelAccountId: string;
}

export interface SuspensionStore {
  /** Every unlifted suspension whose scope could cover this target; the domain decides which one wins. */
  loadCovering(target: SuspensionTargetQuery): Promise<readonly AutomationSuspension[]>;
  suspend(input: NewSuspension): Promise<{ readonly id: string }>;
  lift(id: string, byUserId: string, at: Date): Promise<void>;
}

export interface NewSuspension {
  readonly scope: SuspensionScope;
  readonly workspaceId?: string;
  readonly businessProfileId?: string;
  readonly channelAccountId?: string;
  readonly reason: SuspensionReason;
  readonly note?: string;
  readonly since: Date;
  readonly until?: Date;
  readonly byUserId?: string;
}

export function createSuspensionStore(db: DbClient): SuspensionStore {
  return {
    async loadCovering(target) {
      const rows = await db.automationSuspension.findMany({
        where: {
          liftedAt: null,
          OR: [
            { scope: "GLOBAL" },
            { scope: "WORKSPACE", workspaceId: target.workspaceId },
            { scope: "BUSINESS_PROFILE", workspaceId: target.workspaceId, businessProfileId: target.businessProfileId },
            { scope: "CHANNEL_ACCOUNT", workspaceId: target.workspaceId, channelAccountId: target.channelAccountId },
          ],
        },
        select: { scope: true, workspaceId: true, businessProfileId: true, channelAccountId: true, reason: true, note: true, since: true, until: true, byUserId: true },
      });
      return rows.map((row) => ({
        scope: row.scope,
        ...(row.workspaceId === null ? {} : { workspaceId: row.workspaceId as AutomationSuspension["workspaceId"] }),
        ...(row.businessProfileId === null ? {} : { businessProfileId: row.businessProfileId as AutomationSuspension["businessProfileId"] }),
        ...(row.channelAccountId === null ? {} : { channelAccountId: row.channelAccountId as AutomationSuspension["channelAccountId"] }),
        reason: row.reason,
        ...(row.note === null ? {} : { note: row.note }),
        since: row.since,
        ...(row.until === null ? {} : { until: row.until }),
        ...(row.byUserId === null ? {} : { byUserId: row.byUserId as AutomationSuspension["byUserId"] }),
      }));
    },

    async suspend(input) {
      const created = await db.automationSuspension.create({
        data: {
          scope: input.scope,
          workspaceId: input.workspaceId ?? null,
          businessProfileId: input.businessProfileId ?? null,
          channelAccountId: input.channelAccountId ?? null,
          reason: input.reason,
          note: input.note ?? null,
          since: input.since,
          until: input.until ?? null,
          byUserId: input.byUserId ?? null,
        },
        select: { id: true },
      });
      return created;
    },

    async lift(id, byUserId, at) {
      // Only an unlifted switch can be lifted, so a second click does not rewrite who lifted it first.
      await db.automationSuspension.updateMany({ where: { id, liftedAt: null }, data: { liftedAt: at, liftedByUserId: byUserId } });
    },
  };
}
