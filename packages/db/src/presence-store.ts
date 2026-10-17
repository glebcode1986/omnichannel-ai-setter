/**
 * Everything a presence announcement needs, read in one place (#22, P4-05).
 *
 * It deliberately leans on `loadForSend` rather than reimplementing it. Presence announces that a reply is
 * coming, so the facts it rests on must be the facts the reply itself will rest on — the same statuses, the
 * same takeover state, the same newer-inbound lookup, the same suspension resolution. A second, slimmer
 * reader would be a second definition of "still valid", and the day the two disagreed a customer would
 * watch somebody type a reply that had already been cancelled.
 *
 * Three things are read on top of it, and none of them belong in the send's own read:
 *
 * - **the customer's message as the provider identifies it**, which the send path has no use for;
 * - **what this channel account can actually carry**, from the capabilities onboarding stored, so nothing
 *   here needs to know which channel it is;
 * - **the business's presence settings**, resolved account-override-then-default like every other policy
 *   value.
 *
 * Keeping them out of `loadForSend` keeps a cosmetic feature from widening the read that a send's claim is
 * bound to.
 */
import { DEFAULT_PRESENCE_SETTINGS, type PresenceCapabilities, type PresenceSettings } from "@omnichannel/application";
import type { DeliverySendContext } from "@omnichannel/application";
import { isPresenceMode } from "@omnichannel/domain";

import type { DbClient } from "./client";
import { createDeliveryStore } from "./delivery-store";

export interface PresenceContext {
  /** The same context the delivery coordinator would judge, read the same way. */
  readonly send: DeliverySendContext;
  readonly settings: PresenceSettings;
  readonly capabilities: PresenceCapabilities;
  /** The customer's latest message, which is the one the provider is asked to mark. */
  readonly inboundProviderMessageId?: string;
  readonly inboundOccurredAt?: Date;
}

export interface PresenceStore {
  /**
   * The context for one scheduled reply, or nothing.
   *
   * The workspace is a parameter rather than an output because `operation_id` is globally unique: a
   * lookup by it alone answers for whichever tenant owns it, so a job carrying somebody else's workspace
   * would load a real delivery and announce on a real conversation. The caller states which tenant it
   * believes it is acting for, and a mismatch reads as "no such delivery".
   */
  load(scope: { readonly workspaceId: string; readonly operationId: string }, at: Date): Promise<PresenceContext | undefined>;
}

export function createPresenceStore(db: DbClient): PresenceStore {
  const deliveries = createDeliveryStore(db);
  return {
    async load({ workspaceId, operationId }, at) {
      const send = await deliveries.loadForSend(operationId, at);
      if (send === undefined || send.workspaceId !== workspaceId) {
        return undefined;
      }
      // Read rather than taken from the context: the send's own guard is opaque by design, and widening
      // `DeliverySendContext` for a cosmetic feature would change the shape a claim is bound to.
      const row = await db.deliveryJobRecord.findUnique({ where: { operationId }, select: { businessProfileId: true } });
      if (row === null) {
        return undefined;
      }
      const scope = { workspaceId: send.workspaceId, businessProfileId: row.businessProfileId };
      const [account, inbound, policies] = await Promise.all([
        db.channelAccount.findFirst({ where: { id: send.channelAccountId, workspaceId: send.workspaceId }, select: { capabilities: true } }),
        // The latest one, not the anchor: the provider marks earlier messages in the conversation read
        // along with it, so marking the newest covers the whole burst in one call.
        db.message.findFirst({
          where: { ...scope, conversationId: send.conversationId, direction: "IN" },
          orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
          select: { channelMessageId: true, occurredAt: true },
        }),
        db.automationPolicy.findMany({
          where: { ...scope, OR: [{ channelAccountId: send.channelAccountId }, { channelAccountId: null }] },
          select: { channelAccountId: true, presenceMode: true, presenceTypingLeadMs: true },
        }),
      ]);
      const effective = policies.find((row) => row.channelAccountId === send.channelAccountId) ?? policies.find((row) => row.channelAccountId === null);
      return {
        send,
        settings: presenceSettingsOf(effective),
        capabilities: presenceCapabilitiesOf(account?.capabilities),
        ...(inbound?.channelMessageId === null || inbound?.channelMessageId === undefined ? {} : { inboundProviderMessageId: inbound.channelMessageId }),
        ...(inbound?.occurredAt === undefined ? {} : { inboundOccurredAt: inbound.occurredAt }),
      };
    },
  };
}

/**
 * The presence settings as the application models them.
 *
 * A row the database wrote always satisfies the enum and the range CHECK, so the validation here is about
 * the one case the types cannot cover: no policy row at all, which is a business that never opened the
 * settings page. That one is silent, which is the right default for a promise to a customer.
 */
export function presenceSettingsOf(row: { readonly presenceMode: string; readonly presenceTypingLeadMs: number } | undefined): PresenceSettings {
  if (row === undefined) {
    return DEFAULT_PRESENCE_SETTINGS;
  }
  return {
    mode: isPresenceMode(row.presenceMode) ? row.presenceMode : "OFF",
    typingLeadMs: Number.isFinite(row.presenceTypingLeadMs) && row.presenceTypingLeadMs >= 0 ? row.presenceTypingLeadMs : DEFAULT_PRESENCE_SETTINGS.typingLeadMs,
  };
}

/**
 * What this account can carry, from what onboarding recorded about it.
 *
 * Read from the stored capabilities rather than from the channel's name, so nothing in this file — or in
 * the application above it — has to know which provider is on the other end. An account whose capabilities
 * were never written reads as carrying neither, which declines rather than guesses.
 */
export function presenceCapabilitiesOf(capabilities: unknown): PresenceCapabilities {
  const row = typeof capabilities === "object" && capabilities !== null ? (capabilities as Record<string, unknown>) : {};
  return { readReceipts: row["readReceipts"] === true, typingIndicator: row["typingIndicator"] === true };
}
