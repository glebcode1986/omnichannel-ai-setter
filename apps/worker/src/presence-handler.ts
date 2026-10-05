/**
 * Saying "read", and "typing", at the moment it is still true (#22, P4-05).
 *
 * The job was scheduled when the reply was, 30-120 seconds earlier, and a conversation does not wait: the
 * customer can write again, a colleague can take it over, an operator can suspend the account, the
 * business can switch automation off. Every one of those means the reply will not go out — so every one of
 * them means nothing should be announced, because a typing indicator is a promise that a reply is coming.
 *
 * The judgement is not made here. `presenceVerdict` runs the same policy evaluation the delivery
 * coordinator runs, over the same context, and this file only carries the answer to a provider. That is
 * the whole point of the arrangement: a second, shorter list of conditions living here would drift from
 * the real one, and the drift would show up as a customer watching somebody type a reply that had already
 * been cancelled.
 *
 * **It never throws.** The family allows one attempt and this handler gives it nothing to retry, because
 * an announcement is only meaningful in the seconds before the reply: a retry a minute later would raise
 * a typing indicator after the message had already arrived, which is worse than the silence it was trying
 * to fix. A failed announcement is a cosmetic loss and must never reach the reply.
 */
import { presenceVerdict, type DeliveryChannelStatePort, type PresenceAnnouncer } from "@omnichannel/application";
import type { PresenceStore } from "@omnichannel/db";
import type { Logger } from "@omnichannel/observability";
import type { PresenceJob } from "@omnichannel/queue";

export interface PresenceHandlerDependencies {
  readonly store: PresenceStore;
  /** Absent when this deployment cannot announce on any channel; the handler then declines by name. */
  readonly announcer?: PresenceAnnouncer;
  /** The same derivation the coordinator uses, so both judge one set of channel facts. */
  readonly channel: DeliveryChannelStatePort;
  /** How long the provider keeps a read receipt acceptable. A platform fact, injected by the composition. */
  readonly markReadMaxAgeMs: number;
  readonly logger: Logger;
  readonly now: () => Date;
}

export function createPresenceHandler(dependencies: PresenceHandlerDependencies) {
  return async function onPresence(job: PresenceJob): Promise<void> {
    const fields = {
      correlationId: job.correlationId,
      workspaceId: job.workspaceId,
      businessProfileId: job.businessProfileId,
      conversationId: job.conversationId,
      operationId: job.operationId,
    };
    if (dependencies.announcer === undefined) {
      dependencies.logger.info("worker.presence_skipped", { ...fields, reason: "NO_ANNOUNCER" });
      return;
    }

    const now = dependencies.now();
    const context = await dependencies.store.load({ workspaceId: job.workspaceId, operationId: job.operationId }, now);
    if (context === undefined) {
      // The delivery is gone. Nothing to announce and nothing to say about it beyond that.
      dependencies.logger.info("worker.presence_skipped", { ...fields, reason: "DELIVERY_NOT_SCHEDULED" });
      return;
    }

    const verdict = presenceVerdict(
      { channel: dependencies.channel, now: dependencies.now },
      {
        settings: context.settings,
        capabilities: context.capabilities,
        context: context.send,
        ...(context.inboundProviderMessageId === undefined ? {} : { inboundProviderMessageId: context.inboundProviderMessageId }),
        ...(context.inboundOccurredAt === undefined ? {} : { inboundOccurredAt: context.inboundOccurredAt }),
        markReadMaxAgeMs: dependencies.markReadMaxAgeMs,
        now,
      },
    );
    if (verdict.kind === "SILENT") {
      // At info rather than warn: declining is the designed outcome of a conversation that moved on, not
      // a fault. The reason is what an operator needs to tell "nobody was typing" from "it broke".
      dependencies.logger.info("worker.presence_skipped", { ...fields, reason: verdict.reason });
      return;
    }

    // The job carried what was planned; the verdict carries what is still true. The second one wins, so a
    // channel whose capabilities changed between scheduling and now cannot be asked for something it has
    // stopped offering — and the message to mark is the customer's newest, read back with the context
    // rather than carried in a payload written 30-120 seconds ago.
    const announced = await announceSafely(dependencies, job, verdict);
    dependencies.logger.info("worker.presence_announced", { ...fields, typing: verdict.typing, announced, planned: job.typing });
  };
}

/**
 * The provider call, with its failures absorbed.
 *
 * The announcer's own contract already returns a boolean rather than throwing, so this exists for the one
 * case that contract cannot cover: an implementation that throws anyway. A reply must not be affected by
 * a cosmetic effect under any circumstances, and "under any circumstances" includes a bug in the adapter.
 */
async function announceSafely(
  dependencies: PresenceHandlerDependencies,
  job: PresenceJob,
  verdict: { readonly inboundProviderMessageId: string; readonly typing: boolean },
): Promise<boolean> {
  try {
    return (
      (await dependencies.announcer?.announce({
        workspaceId: job.workspaceId,
        businessProfileId: job.businessProfileId,
        channelAccountId: job.channelAccountId,
        inboundProviderMessageId: verdict.inboundProviderMessageId,
        typing: verdict.typing,
      })) ?? false
    );
  } catch (error) {
    dependencies.logger.warn("worker.presence_failed", {
      correlationId: job.correlationId,
      workspaceId: job.workspaceId,
      operationId: job.operationId,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return false;
  }
}
