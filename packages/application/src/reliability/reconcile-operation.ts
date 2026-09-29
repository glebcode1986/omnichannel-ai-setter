/**
 * Resolving an outbound operation whose outcome is unknown (ADR-012, Issue #56).
 *
 * The rule this file exists to enforce: **nothing here may send.** It decides what is true about a send
 * that already happened, or did not, and the only way it can put a reply back on the path to a customer is
 * `resume`, which re-enters the delivery coordinator — re-reading the conversation, re-running the policy
 * engine, and re-claiming. That is the difference between recovery and queue replay, and it is why a
 * customer who lost interest during a Redis outage does not receive an answer to a question they have
 * since withdrawn.
 *
 * The order of the checks is the substance. Live delivery state is consulted *before* any provider is
 * asked, because our own durable state answers the question outright more often than a provider can:
 *
 * - a job still `SCHEDULED` with no claim is proof that no send was attempted — the worker died before it
 *   reached the transport, so resuming cannot duplicate anything;
 * - a job already `SENT` or cancelled has nothing unknown about it, and asking again would only risk
 *   acting on a stale answer;
 * - a job still `SENDING` belongs to a worker that may be alive. Reconciliation does not race it; the
 *   stale-claim sweeper is what turns an abandoned claim into an ambiguity, and only then is it ours.
 *
 * Only what survives those checks is genuinely ambiguous, and only then is the provider asked. When the
 * provider cannot tell either, the answer is a person — after a grace period, because an echo or a late
 * webhook frequently resolves it on its own within a minute or two, and a review item raised before that
 * is one a person opens to find nothing to do.
 */
import type {
  OpenReconciliation,
  OperationEvidencePort,
  ReconciliationState,
  ReconciliationStore,
  ReconciliationSubject,
} from "./ports";

export interface ReconcileDependencies {
  readonly store: ReconciliationStore;
  readonly evidence: OperationEvidencePort;
  readonly log: { warn(event: string, fields?: Readonly<Record<string, unknown>>): void; info(event: string, fields?: Readonly<Record<string, unknown>>): void };
  readonly now: () => Date;
  /**
   * How long an unresolved operation may stay unresolved before a person is told. Long enough that a late
   * echo or a delayed webhook usually lands first, short enough that a business is not left believing a
   * reply went out when it may not have.
   */
  readonly graceMs: number;
}

/** Exactly what the queue job carried. Nothing here is trusted as current; it only identifies the work. */
export type ReconcileCommand = OpenReconciliation;

export interface ReconcileOutcome {
  readonly state: ReconciliationState;
  readonly evidence: string;
  /** True when this operation should be examined again later; the caller owns the scheduling. */
  readonly retryLater: boolean;
}

/** Statuses that answer the question by themselves: nothing about these operations is unknown. */
const SETTLED: ReadonlySet<ReconciliationSubject["status"]> = new Set([
  "SENT",
  "CANCELLED_SUPERSEDED",
  "CANCELLED_HUMAN_TAKEOVER",
  "CANCELLED_POLICY",
  "HELD_REVIEW",
]);

export async function reconcileOperation(dependencies: ReconcileDependencies, command: ReconcileCommand): Promise<ReconcileOutcome> {
  const at = dependencies.now();
  // The record first, before anything is looked at: from here on the unresolved send exists in the
  // database, not only in a queue that a flush could empty.
  await dependencies.store.open(command);
  const subject = await dependencies.store.load(command.operationId);
  if (subject === undefined) {
    // The operation is gone — a deleted conversation, or a job that never existed. There is nothing to
    // reconcile and nothing to warn about beyond the record itself.
    return { state: "ALREADY_SETTLED", evidence: "the operation no longer exists", retryLater: false };
  }

  const finish = async (state: ReconciliationState, evidence: string, retryLater = false): Promise<ReconcileOutcome> => {
    await dependencies.store.record({
      operationId: subject.operationId,
      deliveryJobId: subject.deliveryJobId,
      conversationId: subject.conversationId,
      reason: subject.reason,
      state,
      evidence,
      at,
    });
    return { state, evidence, retryLater };
  };

  if (SETTLED.has(subject.status)) {
    return finish("ALREADY_SETTLED", `the delivery is ${subject.status}`);
  }

  if (subject.status === "SENDING") {
    // Someone may still be holding this. Claiming otherwise is how two paths conclude opposite things
    // about the same operation; the stale-claim sweeper decides when a claim is abandoned.
    return finish("PENDING", "a worker still holds the claim", true);
  }

  if (subject.claimedAt === undefined) {
    // The claim never happened, so the transport was never reached. This is the one case where resuming
    // is provably safe, and it covers the most common outage shape: a worker that died before sending.
    await dependencies.store.resume(subject.operationId, at);
    dependencies.log.info("reconcile.resumed", { operationId: subject.operationId, reason: subject.reason });
    return finish("RESOLVED_RESUMED", "no claim was ever taken, so no send was attempted");
  }

  if (subject.status === "FAILED_RETRYABLE_EXHAUSTED") {
    // Retries ran out against a transport that kept refusing. Refusals are not ambiguity: the customer
    // received nothing, and a person should decide whether the reply is still worth sending by hand.
    await dependencies.store.escalate(subject.operationId, "delivery failed after every retry", at);
    return finish("NEEDS_HUMAN", "retries were exhausted without a send");
  }

  const evidence = await dependencies.evidence.lookup(subject);
  if (evidence.kind === "SENT") {
    await dependencies.store.markSent(subject.operationId, evidence.platformMessageId, evidence.observedAt);
    dependencies.log.info("reconcile.confirmed_sent", { operationId: subject.operationId });
    return finish("RESOLVED_SENT", "the platform reported the message");
  }
  if (evidence.kind === "NOT_SENT") {
    await dependencies.store.resume(subject.operationId, at);
    dependencies.log.info("reconcile.resumed", { operationId: subject.operationId, reason: subject.reason });
    return finish("RESOLVED_RESUMED", evidence.detail);
  }

  if (at.getTime() - subject.detectedAt.getTime() < dependencies.graceMs) {
    // Still inside the window where a late echo usually settles it. A review item raised now is one a
    // person opens to find nothing to do, and those are what teach people to ignore review items.
    return finish("PENDING", evidence.detail, true);
  }

  await dependencies.store.escalate(subject.operationId, evidence.detail, at);
  dependencies.log.warn("reconcile.needs_human", { operationId: subject.operationId, reason: subject.reason });
  return finish("NEEDS_HUMAN", evidence.detail);
}
