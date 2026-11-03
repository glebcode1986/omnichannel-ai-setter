import type { DebounceScheduler, DeliveryDispatchScheduler, IngestionStore, LogPort, MediaTranscriptionScheduler } from "./ports";
import { outboxRetryDelayMs } from "./rules";

export interface OutboxDispatchDependencies {
  readonly store: IngestionStore;
  readonly scheduler: DebounceScheduler;
  /**
   * Where a reading job goes (Issue #21).
   *
   * Required rather than optional, even in a deployment with no transcriber configured. The queue accepts
   * the job either way and the handler is what reports "not configured" — an optional scheduler here would
   * instead leave the entry undispatchable, retrying until its lease expires, forever.
   */
  readonly transcription: MediaTranscriptionScheduler;
  /**
   * Where an approved or human-written reply goes (Issue #125).
   *
   * Required, like `transcription` and for a sharper reason: a deployment that left this out would accept
   * every approval, commit every delivery row, and never send one — which is precisely the defect this
   * dependency was added to make impossible to reintroduce by omission.
   */
  readonly delivery: DeliveryDispatchScheduler;
  readonly log: LogPort;
  readonly now: () => Date;
}

export interface OutboxDispatchResult {
  readonly dispatched: number;
  readonly failed: number;
}

const OUTBOX_LEASE_MS = 30_000;
const DEFAULT_BATCH_SIZE = 100;

/**
 * Transactional outbox dispatch: entries were committed together with the inbound message, so a failed or
 * interrupted enqueue is retried later instead of being lost. Enqueueing twice is harmless because queue job
 * IDs are deterministic and the reply-cycle claim is idempotent.
 */
export async function dispatchOutbox(
  dependencies: OutboxDispatchDependencies,
  options: { readonly ids?: readonly string[]; readonly limit?: number } = {},
): Promise<OutboxDispatchResult> {
  const { store, scheduler, transcription, delivery, log, now } = dependencies;
  const claimedAt = now();
  const entries = await store.claimOutboxEntries({
    now: claimedAt,
    limit: options.limit ?? DEFAULT_BATCH_SIZE,
    leaseMs: OUTBOX_LEASE_MS,
    ...(options.ids === undefined ? {} : { ids: options.ids }),
  });

  let dispatched = 0;
  let failed = 0;
  for (const entry of entries) {
    const fields = {
      outboxEntryId: entry.id,
      workspaceId: entry.workspaceId,
      businessProfileId: entry.businessProfileId,
      correlationId: entry.correlationId,
    };
    const current = now();
    // The debounce window counts from when the message was stored, so a late dispatch fires sooner.
    const delayMs = Math.max(0, entry.createdAt.getTime() + entry.delayMs - current.getTime());
    try {
      // Dispatched by kind, which the union makes exhaustive: a payload cannot reach the wrong queue.
      // A `switch` rather than the `if/else` this was, because the third kind (Issue #125) is a *send*.
      // With two kinds the `else` was merely terse; with three it would route an approved reply into the
      // debounce queue, where nothing would ever send it — the same shape of silence this kind exists to
      // end. `switch-exhaustiveness-check` now also refuses a fourth kind that nobody routed.
      switch (entry.kind) {
        case "MEDIA_TRANSCRIPTION":
          await transcription.scheduleMediaTranscription(entry.payload, { delayMs });
          break;
        case "DELIVERY_DISPATCH":
          await delivery.scheduleDeliveryDispatch(entry.payload, { delayMs });
          break;
        case "INBOUND_DEBOUNCE":
          await scheduler.scheduleInboundDebounce(entry.payload, { delayMs });
          break;
      }
    } catch (error) {
      failed += 1;
      const retryAt = new Date(current.getTime() + outboxRetryDelayMs(entry.attempts));
      log.warn("outbox.dispatch_failed", { ...fields, attempts: entry.attempts, retryAt: retryAt.toISOString(), errorName: errorName(error) });
      await store.markOutboxFailed({ id: entry.id, errorName: errorName(error), retryAt }).catch((markError: unknown) => {
        // The lease expires on its own, so the entry is still retried.
        log.error("outbox.mark_failed_failed", { ...fields, errorName: errorName(markError) });
      });
      continue;
    }
    try {
      await store.markOutboxDispatched({ id: entry.id, now: now() });
      dispatched += 1;
      log.info("outbox.dispatched", { ...fields, delayMs });
    } catch (error) {
      // Enqueued but not marked: a later retry enqueues the same deterministic job again, which is a no-op.
      failed += 1;
      log.error("outbox.mark_dispatched_failed", { ...fields, errorName: errorName(error) });
    }
  }
  return { dispatched, failed };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
