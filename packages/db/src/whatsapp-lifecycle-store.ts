/**
 * Applying a coexistence offboard or reconnection (#23, P4-06).
 *
 * Scoped by the messaging account the webhook names, not by a user: this runs from a webhook and there is
 * nobody behind it. The same shape as `applyTemplateStatusUpdate`, and for the same reason — inventing an
 * authorization context so a background write would type-check is how a background path acquires authority
 * nobody granted.
 *
 * **Offboarding pauses sends, which is Meta's own instruction to integrators.** It is applied as
 * `NEEDS_REAUTH` rather than `DISCONNECTED` because that is what actually happened: the number still
 * exists, the business still has it, and Meta reconnects it automatically — "typically within a few
 * minutes" — once the client opts back in. `NEEDS_REAUTH` already refuses every automated send through the
 * policy engine's `ACCOUNT_UNHEALTHY` gate *and* is re-asserted by the delivery claim, so a reply
 * scheduled before the offboard is held at the moment it comes due rather than sent on an authorization
 * that has been withdrawn. No second mechanism, and nothing to keep in step with the first.
 *
 * **Reconnection restores only what offboarding took.** It returns an account to `CONNECTED` only if this
 * is why it left — a number that needed re-authorization for some other reason, or that an operator
 * disconnected, is not quietly reconnected by a provider event about something else.
 */
import type { DbExecutor } from "./client";

/** Written on the connection so an operator can see why, and so reconnection knows what it may undo. */
export const OFFBOARDED_HEALTH_REASON = "COEXISTENCE_OFFBOARDED";

export interface AccountLifecycleUpdate {
  /** The messaging account the provider named. A number is never named, because the event is not about one. */
  readonly wabaId: string;
  readonly event: "OFFBOARDED" | "RECONNECTED";
  /** The provider's own reason code when it supplies one. Never its prose. */
  readonly reason?: string;
  readonly at: Date;
}

export async function applyAccountLifecycle(db: DbExecutor, update: AccountLifecycleUpdate): Promise<{ readonly updated: number }> {
  const connections = await db.whatsAppConnection.findMany({
    where: { wabaId: update.wabaId },
    select: { id: true, workspaceId: true, businessProfileId: true, channelAccountId: true, healthReason: true },
  });
  if (connections.length === 0) {
    // A lifecycle event for a messaging account nobody connected. Matching no row and changing nothing is
    // the right answer: the scope is a provider asset, and an unknown one is not ours.
    return { updated: 0 };
  }

  let updated = 0;
  for (const connection of connections) {
    const scope = { workspaceId: connection.workspaceId, businessProfileId: connection.businessProfileId };
    if (update.event === "OFFBOARDED") {
      const changed = await db.channelAccount.updateMany({
        // Only from a working state. An account already needing re-authorization, or one an operator
        // disconnected, is not moved by this — the reason it is unusable is already recorded.
        where: { ...scope, id: connection.channelAccountId, status: { in: ["CONNECTED", "DEGRADED"] } },
        data: { status: "NEEDS_REAUTH" },
      });
      await db.whatsAppConnection.updateMany({
        where: { workspaceId: connection.workspaceId, id: connection.id },
        data: { healthReason: OFFBOARDED_HEALTH_REASON },
      });
      updated += changed.count;
      continue;
    }
    // Reconnection undoes exactly what offboarding did, and nothing else: the health reason is the record
    // of why the account left, so an account that left for another reason stays where it is.
    if (connection.healthReason !== OFFBOARDED_HEALTH_REASON) {
      continue;
    }
    const changed = await db.channelAccount.updateMany({
      where: { ...scope, id: connection.channelAccountId, status: "NEEDS_REAUTH" },
      data: { status: "CONNECTED" },
    });
    await db.whatsAppConnection.updateMany({ where: { workspaceId: connection.workspaceId, id: connection.id }, data: { healthReason: null } });
    updated += changed.count;
  }
  return { updated };
}
