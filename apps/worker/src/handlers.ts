import { NonRetryableJobError, type QueueHandlers } from "@omnichannel/queue";

import type { DeliveryAttemptResult, DeliveryJob } from "@omnichannel/queue";

import type { AiDraftJob } from "./ai-draft-handler";
import { draftJobFromDebounce } from "./ai-draft-handler";

/**
 * Phase 2 processors. Draft generation and delivery are wired; the reply-cycle handler that decides when to
 * draft (#16) is not, so it still fails visibly rather than pretending.
 */
export function createHandlers(
  generateDraft: (job: AiDraftJob) => Promise<void>,
  deliver: (job: DeliveryJob) => Promise<DeliveryAttemptResult>,
): QueueHandlers {
  const notImplemented = (what: string) => () => Promise.reject(new NonRetryableJobError(`${what} is not implemented yet`));
  return {
    // The debounce handler will orchestrate retrieval and generation in #16; drafting from it directly now
    // would skip the policy work that task owns.
    onInboundDebounceElapsed: notImplemented("inbound debounce handling"),
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
