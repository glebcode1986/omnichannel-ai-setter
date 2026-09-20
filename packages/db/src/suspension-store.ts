/**
 * Reading and writing the automated-outbound kill switch (Issue #56).
 *
 * Loading is deliberately generous: every live suspension that could possibly cover this target, decided
 * in the database by scope, and then narrowed by the domain function that knows the nesting rules. Two
 * places knowing "widest wins" is exactly how a switch ends up honoured in one path and ignored in another.
 *
 * Lifting never deletes. The question after an incident is always who turned this off and whether anyone
 * turned it back on, and a deleted row cannot answer either half.
 *
 * The identifiers come back through the domain's own constructors rather than a cast. A cast at a
 * persistence boundary is a promise the compiler cannot check, and these particular identifiers decide
 * which sends a switch covers.
 */
import {
  toBusinessProfileId,
  toChannelAccountId,
  toUserId,
  toWorkspaceId,
  type AutomationSuspension,
  type SuspensionReason,
  type SuspensionScope,
} from "@omnichannel/domain";

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
  /**
   * The switch the system pulled for one reason, while it is still in force.
   *
   * "The system's" means global, unlifted and attributed to nobody. Every write below is restricted the
   * same way, so an automatic guard can never extend, shorten or end a switch a person pulled — which is
   * the one thing an automatic guard must never do.
   */
  activeSystemSuspension(reason: SuspensionReason, at: Date): Promise<SystemSuspension | undefined>;
  /** Opens the system's switch, or pushes the end of the one already in force further out. */
  holdSystemSuspension(input: { readonly reason: SuspensionReason; readonly note: string; readonly until: Date; readonly at: Date }): Promise<void>;
  /**
   * Ends the system's switch now.
   *
   * By closing its window rather than by recording a lift: a lift names the person who decided the danger
   * had passed, and no person decided this. Writing the system into that column would put a lie in the
   * one record an incident review reads most carefully.
   */
  endSystemSuspension(reason: SuspensionReason, at: Date): Promise<void>;
}

export interface SystemSuspension {
  readonly id: string;
  readonly since: Date;
  readonly until?: Date;
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
        ...(row.workspaceId === null ? {} : { workspaceId: toWorkspaceId(row.workspaceId) }),
        ...(row.businessProfileId === null ? {} : { businessProfileId: toBusinessProfileId(row.businessProfileId) }),
        ...(row.channelAccountId === null ? {} : { channelAccountId: toChannelAccountId(row.channelAccountId) }),
        reason: row.reason,
        ...(row.note === null ? {} : { note: row.note }),
        since: row.since,
        ...(row.until === null ? {} : { until: row.until }),
        ...(row.byUserId === null ? {} : { byUserId: toUserId(row.byUserId) }),
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

    async activeSystemSuspension(reason, at) {
      const row = await db.automationSuspension.findFirst({
        where: { scope: "GLOBAL", reason, byUserId: null, liftedAt: null, since: { lte: at }, OR: [{ until: null }, { until: { gt: at } }] },
        select: { id: true, since: true, until: true },
        orderBy: { since: "desc" },
      });
      return row === null ? undefined : { id: row.id, since: row.since, ...(row.until === null ? {} : { until: row.until }) };
    },

    async holdSystemSuspension(input) {
      const active = await this.activeSystemSuspension(input.reason, input.at);
      if (active === undefined) {
        await db.automationSuspension.create({
          data: { scope: "GLOBAL", reason: input.reason, note: input.note, since: input.at, until: input.until, byUserId: null },
        });
        return;
      }
      // Extend, never shorten: a tick that measured a briefly better moment must not be able to end a
      // stop the previous tick decided on, and `until` is the deadline, not a running countdown.
      await db.automationSuspension.updateMany({
        where: { id: active.id, liftedAt: null, byUserId: null, OR: [{ until: null }, { until: { lt: input.until } }] },
        data: { until: input.until, note: input.note },
      });
    },

    async endSystemSuspension(reason, at) {
      // `until` must stay after `since` (CHECK), so a switch opened in this same instant cannot be closed
      // in it. That is the right direction to fail: it lapses on its own a few minutes later.
      await db.automationSuspension.updateMany({
        where: { scope: "GLOBAL", reason, byUserId: null, liftedAt: null, since: { lt: at }, OR: [{ until: null }, { until: { gt: at } }] },
        data: { until: at },
      });
    },
  };
}
