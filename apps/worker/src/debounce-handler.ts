/**
 * The debounce window elapsing: the moment a burst of customer messages becomes one reply to write (#16).
 *
 * It does exactly one thing — enqueue the draft generation job — and deliberately no more. Generating
 * inline would put retrieval and a model call inside a handler whose own job is timing, and it would give
 * the generation a different retry story from every other piece of work in the system.
 *
 * The trigger it produces is always `AUTOMATIC`. An inbound message has no person behind it to name, which
 * is what makes a background job unable to express a human request even by accident.
 */
import type { Logger } from "@omnichannel/observability";
import type { InboundDebounceJob, QueueProducer } from "@omnichannel/queue";

export interface DebounceHandlerDependencies {
  readonly producer: QueueProducer;
  readonly logger: Logger;
}

export function createDebounceHandler(dependencies: DebounceHandlerDependencies) {
  return async function onInboundDebounceElapsed(job: InboundDebounceJob): Promise<void> {
    // The queue layer only calls this while the anchor still owns the reply cycle, so a burst that has
    // already been overtaken never reaches here — and the draft engine re-checks anyway.
    await dependencies.producer.enqueueAiDraftGeneration({
      schemaVersion: 1,
      workspaceId: job.workspaceId,
      businessProfileId: job.businessProfileId,
      correlationId: job.correlationId,
      conversationId: job.conversationId,
      anchorMessageId: job.anchorMessageId,
      trigger: { kind: "AUTOMATIC", reason: "DEBOUNCE_ELAPSED" },
    });
    dependencies.logger.info("worker.debounce_elapsed", {
      correlationId: job.correlationId,
      conversationId: job.conversationId,
      anchorMessageId: job.anchorMessageId,
    });
  };
}
