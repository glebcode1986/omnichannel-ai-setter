import { NonRetryableJobError, type QueueHandlers } from "@omnichannel/queue";

/**
 * Phase 1 processors. The queue primitives run, but the business handlers arrive with later tasks
 * (ingestion #6, AI drafts and the delivery coordinator in Phase 2). Until then jobs fail visibly without
 * retries, and delivery reports "not claimed" so nothing is ever sent.
 */
export function createPlaceholderHandlers(): QueueHandlers {
  const notImplemented = (what: string) => () => Promise.reject(new NonRetryableJobError(`${what} is not implemented yet`));
  return {
    onInboundDebounceElapsed: notImplemented("inbound debounce handling"),
    generateAiDraft: notImplemented("AI draft generation"),
    deliver: () =>
      Promise.resolve({ status: "NOT_CLAIMED", retryable: false, reason: "delivery coordinator is not implemented yet" }),
    reconcile: notImplemented("delivery reconciliation"),
  };
}
