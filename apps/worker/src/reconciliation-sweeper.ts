/**
 * The durable half of reconciliation (ADR-012, Issue #56).
 *
 * The queue is a convenience; this is the system of record. Three situations end with an unresolved send
 * that no job is coming back for, and each of them is an outage shape rather than an edge case:
 *
 * - the reconciliation job exhausted its attempts while the answer was still unknown;
 * - Redis lost the job — which is likely precisely when Redis was the dependency that failed;
 * - a delivery was quarantined as ambiguous and the enqueue that should have opened an investigation
 *   never happened, for the same reason.
 *
 * The sweep raises them again from PostgreSQL, so "we do not know whether the customer received this"
 * survives everything except the database itself.
 *
 * Stale claims are swept first and deliberately: that pass is what turns a worker that died mid-send into
 * an ambiguity, and running it second would leave those operations invisible for a whole interval.
 */
import type { UnresolvedOperation } from "@omnichannel/db";
import type { Logger } from "@omnichannel/observability";
import type { QueueProducer } from "@omnichannel/queue";

import { startRecoveryLoop, type RecoveryLoop } from "./recovery-loop";

export interface ReconciliationSweeperOptions {
  readonly intervalMs: number;
  /** How long an unresolved operation may go unexamined before it is raised again. */
  readonly retryAfterMs: number;
  readonly limit: number;
  /** Quarantines deliveries whose claim outlived its lease; returns the operations it quarantined. */
  readonly recoverStaleClaims: () => Promise<readonly string[]>;
  readonly findUnresolved: (options: { readonly retryBefore: Date; readonly limit: number }) => Promise<readonly UnresolvedOperation[]>;
  readonly producer: QueueProducer;
  readonly logger: Logger;
  readonly now: () => Date;
}

export function startReconciliationSweeper(options: ReconciliationSweeperOptions): RecoveryLoop {
  return startRecoveryLoop({
    name: "reconciliation_swept",
    intervalMs: options.intervalMs,
    logger: options.logger,
    tick: async () => {
      const stale = await options.recoverStaleClaims();
      const at = options.now();
      const unresolved = await options.findUnresolved({
        retryBefore: new Date(at.getTime() - options.retryAfterMs),
        limit: options.limit,
      });
      if (unresolved.length === 0) {
        return stale.length === 0 ? undefined : { staleClaims: stale.length, raised: 0 };
      }
      let raised = 0;
      for (const operation of unresolved) {
        try {
          await options.producer.enqueueReconciliation({
            schemaVersion: 1,
            workspaceId: operation.workspaceId,
            businessProfileId: operation.businessProfileId,
            correlationId: operation.correlationId,
            conversationId: operation.conversationId,
            deliveryJobId: operation.deliveryJobId,
            operationId: operation.operationId,
            reason: operation.reason,
            detectedAt: operation.detectedAt.toISOString(),
            ...(operation.providerRequestId === undefined ? {} : { providerRequestId: operation.providerRequestId }),
          },
          // The previous job may still be retained in a failed state, and a retained identity makes an
          // ordinary enqueue a silent no-op. This is the sweeper's whole purpose, so it replaces it —
          // unless a worker is holding the job right now, in which case nothing is removed and the add
          // is the ordinary no-op, which is the correct answer.
          { replaceRetained: true });
          raised += 1;
        } catch (error) {
          // One unreachable queue must not stop the sweep: the rest of the batch is still worth raising,
          // and this one is still in the database to be raised next time.
          options.logger.warn("worker.reconciliation_raise_failed", {
            operationId: operation.operationId,
            errorName: error instanceof Error ? error.name : typeof error,
          });
        }
      }
      return { staleClaims: stale.length, raised, found: unresolved.length };
    },
  });
}
