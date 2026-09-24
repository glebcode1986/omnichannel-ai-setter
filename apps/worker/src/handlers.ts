import { NonRetryableJobError, type QueueHandlers } from "@omnichannel/queue";

import type { AiDraftJob } from "./ai-draft-handler";
import { draftJobFromDebounce } from "./ai-draft-handler";

/**
 * Phase 2 processors. AI draft generation is wired; the delivery coordinator (#13) and the reply-cycle
 * handler that decides when to draft (#16) are not, so those still fail visibly rather than pretending.
 */
export function createHandlers(generateDraft: (job: AiDraftJob) => Promise<void>): QueueHandlers {
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
    deliver: () =>
      Promise.resolve({ status: "NOT_CLAIMED", retryable: false, reason: "delivery coordinator is not implemented yet" }),
    reconcile: notImplemented("delivery reconciliation"),
  };
}

export { draftJobFromDebounce };
