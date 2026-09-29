import { NonRetryableJobError, type QueueHandlers } from "@omnichannel/queue";

import type { DeliveryAttemptResult, DeliveryJob, InboundDebounceJob } from "@omnichannel/queue";

import type { AiDraftJob } from "./ai-draft-handler";
import { draftJobFromDebounce } from "./ai-draft-handler";

/**
 * Phase 2 processors, all wired: a debounce window elapsing enqueues generation, generation hands the
 * draft to the shared policy engine, and delivery runs through the one coordinator. Reconciliation is
 * still a placeholder and fails visibly rather than pretending.
 */
export function createHandlers(
  generateDraft: (job: AiDraftJob) => Promise<void>,
  deliver: (job: DeliveryJob) => Promise<DeliveryAttemptResult>,
  onInboundDebounceElapsed: (job: InboundDebounceJob) => Promise<void>,
): QueueHandlers {
  const notImplemented = (what: string) => () => Promise.reject(new NonRetryableJobError(`${what} is not implemented yet`));
  return {
    // Enqueues generation rather than drafting inline: timing and generation have different retry stories.
    onInboundDebounceElapsed: (job) => onInboundDebounceElapsed(job),
    generateAiDraft: (job) =>
      generateDraft({
        workspaceId: job.workspaceId,
        businessProfileId: job.businessProfileId,
        conversationId: job.conversationId,
        anchorMessageId: job.anchorMessageId,
        // Carried across whole, never reconstructed: rebuilding it here is exactly where a background job
        // could acquire an authority it was never given.
        trigger:
          job.trigger.kind === "HUMAN_REQUEST"
            ? { ...job.trigger, requestedAt: new Date(job.trigger.requestedAt) }
            : job.trigger,
        correlationId: job.correlationId,
      }),
    // The coordinator owns every decision inside; this only hands it the job.
    deliver: (job) => deliver(job),
    reconcile: notImplemented("delivery reconciliation"),
  };
}

export { draftJobFromDebounce };
