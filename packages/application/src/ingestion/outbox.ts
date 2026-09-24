import type { DebounceScheduler, IngestionStore, LogPort } from "./ports";
import { outboxRetryDelayMs } from "./rules";

export interface OutboxDispatchDependencies {
  readonly store: IngestionStore;
  readonly scheduler: DebounceScheduler;
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
  const { store, scheduler, log, now } = dependencies;
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
      await scheduler.scheduleInboundDebounce(entry.payload, { delayMs });
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
