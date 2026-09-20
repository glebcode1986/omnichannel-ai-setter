/**
 * Reconciliation boundaries (ADR-012, Issue #56).
 *
 * A send whose outcome is unknown is the one failure this system cannot shrug off: retrying may duplicate
 * a customer message, and abandoning it may drop a reply the business believes it sent. ADR-012 forbids the
 * blind retry, which leaves exactly one honest option — find out, and when finding out is impossible, say
 * so to a person.
 *
 * The ports are shaped so the dangerous move is not expressible. There is no `resend` here. The only way
 * back into sending is `resume`, which re-enters the delivery coordinator and therefore the policy engine:
 * recovery is reconcile -> revalidate -> resume, never queue replay. A reply the customer has since made
 * irrelevant is re-judged on the way out, exactly as a fresh one would be.
 */
import type { ReconciliationReason } from "@omnichannel/domain";

/** What the durable record knows about one unresolved operation. */
export interface ReconciliationSubject {
  readonly operationId: string;
  readonly deliveryJobId: string;
  readonly conversationId: string;
  /** The delivery row's live status; the whole decision turns on it. */
  readonly status: DeliveryStatusForReconciliation;
  /** Null until a worker claimed the send. A claim that never happened is proof no send was attempted. */
  readonly claimedAt?: Date;
  readonly attemptCount: number;
  readonly providerRequestId?: string;
  /** When the ambiguity was first observed, which is what the grace period is measured from. */
  readonly detectedAt: Date;
  readonly reason: ReconciliationReason;
}

export type DeliveryStatusForReconciliation =
  | "SCHEDULED"
  | "SENDING"
  | "SENT"
  | "CANCELLED_SUPERSEDED"
  | "CANCELLED_HUMAN_TAKEOVER"
  | "CANCELLED_POLICY"
  | "HELD_REVIEW"
  | "HELD_AMBIGUOUS"
  | "FAILED_RETRYABLE_EXHAUSTED";

/**
 * Provider-side evidence about one operation.
 *
 * `UNKNOWN` is a first-class answer, not a failure: most transports cannot be asked "did request X create
 * a message?" after the fact, and an implementation that guessed would be worse than one that admits it.
 * Text similarity is never evidence here (ADR-013).
 */
export type OperationEvidence =
  | { readonly kind: "SENT"; readonly platformMessageId: string; readonly observedAt: Date }
  | { readonly kind: "NOT_SENT"; readonly detail: string }
  | { readonly kind: "UNKNOWN"; readonly detail: string };

export interface OperationEvidencePort {
  lookup(subject: ReconciliationSubject): Promise<OperationEvidence>;
}

/** How a reconciliation ended. Stored, because "we asked and could not tell" is itself an audit fact. */
export const RECONCILIATION_STATES = [
  /** Examined, still unresolved, and inside the grace period; it will be asked again. */
  "PENDING",
  /** Provider-side evidence says the customer received it. */
  "RESOLVED_SENT",
  /** No send happened, and the reply was handed back to the coordinator to re-judge and resume. */
  "RESOLVED_RESUMED",
  /** Nobody can tell from outside. A person now owns the question. */
  "NEEDS_HUMAN",
  /** Something else settled the operation first; there is no longer anything unknown about it. */
  "ALREADY_SETTLED",
] as const;
export type ReconciliationState = (typeof RECONCILIATION_STATES)[number];

export interface ReconciliationStore {
  /**
   * Ensures a durable record exists for this unresolved operation, and returns what is already known
   * about it.
   *
   * Written before anything is examined, because the queue is not the record. A Redis flush, a dropped
   * job or a worker that dies mid-reconciliation must not be able to make an unresolved send disappear;
   * after this call the operation is visible to an operator whatever happens to the job.
   */
  open(input: OpenReconciliation): Promise<void>;
  /** The operation as it stands now, re-read rather than trusted from the queue payload. */
  load(operationId: string): Promise<ReconciliationSubject | undefined>;
  /** Records that the send did reach the customer, with the identifier that proves it. */
  markSent(operationId: string, platformMessageId: string, at: Date): Promise<void>;
  /** Returns the operation to the coordinator for a fresh decision. Never a direct send. */
  resume(operationId: string, at: Date): Promise<void>;
  /** Hands the question to a person: the draft becomes a review item explaining what is unknown. */
  escalate(operationId: string, detail: string, at: Date): Promise<void>;
  /** Writes the reconciliation record itself — attempt count, state and how it was concluded. */
  record(input: ReconciliationRecord): Promise<void>;
}

export interface OpenReconciliation {
  readonly workspaceId: string;
  readonly businessProfileId: string;
  readonly operationId: string;
  readonly deliveryJobId: string;
  readonly conversationId: string;
  readonly reason: ReconciliationReason;
  readonly detectedAt: Date;
  readonly providerRequestId?: string;
  readonly providerCode?: string;
}

export interface ReconciliationRecord {
  readonly operationId: string;
  readonly deliveryJobId: string;
  readonly conversationId: string;
  readonly reason: ReconciliationReason;
  readonly state: ReconciliationState;
  /** One short phrase saying how it was concluded. Never a provider response body, never a secret. */
  readonly evidence: string;
  readonly at: Date;
}
