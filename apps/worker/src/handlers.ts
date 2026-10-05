import type { QueueHandlers } from "@omnichannel/queue";

import type { DeliveryAttemptResult, DeliveryJob, InboundDebounceJob, MediaTranscriptionJob, ReconciliationJob } from "@omnichannel/queue";

import type { AiDraftJob } from "./ai-draft-handler";
import { draftJobFromDebounce } from "./ai-draft-handler";

/**
 * Every processor, wired: a debounce window elapsing enqueues generation, generation hands the draft to
 * the shared policy engine, delivery runs through the one coordinator, and a send whose outcome is
 * unknown is investigated rather than retried (ADR-012).
 */
export function createHandlers(
  generateDraft: (job: AiDraftJob) => Promise<void>,
  deliver: (job: DeliveryJob) => Promise<DeliveryAttemptResult>,
  onInboundDebounceElapsed: (job: InboundDebounceJob) => Promise<void>,
  transcribeMedia: (job: MediaTranscriptionJob) => Promise<void>,
  reconcile: (job: ReconciliationJob) => Promise<void>,
): QueueHandlers {
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
    // Reads a recording and records what came of it. Terminal failures never throw, so the family's
    // attempts are spent only on failures that could still succeed (Issue #21).
    transcribeMedia: (job) => transcribeMedia(job),
    // The coordinator owns every decision inside; this only hands it the job.
    deliver: (job) => deliver(job),
    // Never a resend: the reconciler can confirm, resume through the coordinator, or ask a person.
    reconcile: (job) => reconcile(job),
  };
}

export { draftJobFromDebounce };
