/**
 * Handing a human-decided reply to the delivery queue, durably (Issue #125).
 *
 * The defect this closes, in full, because it is the kind that reads as finished code. `resolveApproval`
 * and `composeHumanReply` each committed a `delivery_jobs` row with `status = 'SCHEDULED'` and **nothing
 * enqueued the job that sends it**. Production enqueues existed only on the AUTOPILOT path
 * (`apps/worker/src/draft-disposition.ts`) and on reconciliation resume (`apps/worker/src/reconcile-handler.ts`),
 * and the reconciliation sweep's selection takes `HELD_AMBIGUOUS` rows only — never `SCHEDULED`. So a
 * person approved a reply, the screen said it was sent, and the customer received nothing. Worse, the
 * abandoned row then satisfied the "a reply is already in flight" check in `composer-store.ts`, so the
 * conversation could not be answered again at all.
 *
 * **Why the outbox rather than an enqueue beside the commit.** The row and the intent to send it must
 * commit together or not at all. An `await producer.scheduleDelivery(...)` placed after the transaction
 * loses the send whenever Redis is unavailable in that instant, and placed *inside* it enqueues work for a
 * transaction that may still roll back — a send that never happened, or a send of a decision that was
 * undone. `queue_outbox` already solves this for ingestion: the entry is written in the caller's
 * transaction, and `dispatchOutbox` moves it to the queue afterwards, retrying from PostgreSQL for as long
 * as it takes. Nothing new is invented here; one more `kind` joins a mechanism that already carries the
 * product's other two durable hand-offs.
 *
 * **Idempotency comes from the database, not from care.** `queue_outbox.dedupe_key` is `UNIQUE` and the
 * insert uses `skipDuplicates`, so the dedupe key *is* the idempotency statement. It is built from
 * `operationId`, which the delivery row itself calls the "stable idempotency identity of the outbound
 * action", so a duplicated click, a replayed request and a retried transaction all collapse onto one
 * entry. A key built from anything per-request — a timestamp, a random id, the row's own id — would make
 * every retry a second send, which is the one failure a messaging product must never have.
 *
 * The payload carries exactly the `DeliveryJob` fields the queue's own schema validates, and no more: the
 * worker re-reads everything that decides whether a send may still happen — channel eligibility, tenancy,
 * human takeover, the kill switch, policy — from the database at send time. A payload that carried those
 * answers would be a cache of permissions, and a stale one would send a reply the business had already
 * revoked.
 */
import type { DbExecutor } from "./client";

/** How a dispatch entry is named, so every writer and every reader agrees on one spelling. */
export const DELIVERY_DISPATCH_DEDUPE_PREFIX = "delivery-dispatch";

/**
 * The dedupe key for one outbound action.
 *
 * Scoped by Workspace and Business Profile as well as `operationId`: the id is a UUID and collision is not
 * the concern, but a key that names its tenant is readable in an incident and cannot be made to mean a
 * different tenant's work by a mistake elsewhere.
 */
export function deliveryDispatchDedupeKey(input: {
  readonly workspaceId: string;
  readonly businessProfileId: string;
  readonly operationId: string;
}): string {
  return [DELIVERY_DISPATCH_DEDUPE_PREFIX, input.workspaceId, input.businessProfileId, input.operationId].join(":");
}

export interface DeliveryDispatchRequest {
  readonly workspaceId: string;
  readonly businessProfileId: string;
  readonly conversationId: string;
  /** Absent when a person composed the reply themselves (ADR-018 Option B). */
  readonly draftId?: string;
  readonly deliveryJobId: string;
  readonly operationId: string;
  readonly correlationId: string;
  readonly scheduledFor: Date;
  readonly selectedDelayMs: number;
}

/**
 * Writes the dispatch entry **in the caller's transaction**.
 *
 * Returns whether an entry was added. `false` means an entry for this `operationId` already existed, which
 * is a replay rather than an error and is why the insert is `skipDuplicates` instead of a plain create: the
 * caller has already decided, further up, that the same decision arriving twice is answered with the send
 * that exists.
 *
 * `delayMs` is zero and that is a product statement, not a default. A human has just decided; the
 * randomized human-like delay belongs to automation deciding on its own, and the delivery row records
 * `selectedDelayMs: 0` for the same reason. The queue's own `delay` is therefore the entry's, not the
 * reply's — `dispatchOutbox` recomputes it from `created_at`, so an entry dispatched late is not delayed
 * twice.
 */
export async function addDeliveryDispatchEntry(tx: DbExecutor, input: DeliveryDispatchRequest): Promise<boolean> {
  const created = await tx.queueOutbox.createManyAndReturn({
    data: [
      {
        workspaceId: input.workspaceId,
        businessProfileId: input.businessProfileId,
        kind: "DELIVERY_DISPATCH",
        dedupeKey: deliveryDispatchDedupeKey(input),
        correlationId: input.correlationId,
        delayMs: 0,
        payload: {
          schemaVersion: 1,
          workspaceId: input.workspaceId,
          businessProfileId: input.businessProfileId,
          correlationId: input.correlationId,
          conversationId: input.conversationId,
          ...(input.draftId === undefined ? {} : { draftId: input.draftId }),
          deliveryJobId: input.deliveryJobId,
          operationId: input.operationId,
          scheduledFor: input.scheduledFor.toISOString(),
          selectedDelayMs: input.selectedDelayMs,
        },
      },
    ],
    skipDuplicates: true,
    select: { id: true },
  });
  return created.length === 1;
}
