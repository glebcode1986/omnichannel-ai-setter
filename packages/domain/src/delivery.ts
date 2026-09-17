import { literalGuard } from "./enum";
import type { AiDraftId, CorrelationId, DeliveryJobId, OperationId, WorkspaceId } from "./ids";

/** Durable delivery states (DELIVERY_COORDINATOR.md, ADR-012). */
export const DELIVERY_JOB_STATUSES = [
  "SCHEDULED",
  "SENDING",
  "SENT",
  "CANCELLED_SUPERSEDED",
  "CANCELLED_HUMAN_TAKEOVER",
  "CANCELLED_POLICY",
  "HELD_REVIEW",
  "HELD_AMBIGUOUS",
  "FAILED_RETRYABLE_EXHAUSTED",
] as const;
export type DeliveryJobStatus = (typeof DELIVERY_JOB_STATUSES)[number];
export const isDeliveryJobStatus = literalGuard(DELIVERY_JOB_STATUSES);

/** States after which the job must never send again. HELD_AMBIGUOUS is final for automation: never auto-resend. */
export const FINAL_DELIVERY_JOB_STATUSES = [
  "SENT",
  "CANCELLED_SUPERSEDED",
  "CANCELLED_HUMAN_TAKEOVER",
  "CANCELLED_POLICY",
  "HELD_AMBIGUOUS",
  "FAILED_RETRYABLE_EXHAUSTED",
] as const satisfies readonly DeliveryJobStatus[];
export const isFinalDeliveryJobStatus = literalGuard(FINAL_DELIVERY_JOB_STATUSES);

export interface DeliveryError {
  readonly code?: string;
  readonly message: string;
}

export interface DeliveryJobRecord {
  readonly id: DeliveryJobId;
  readonly workspaceId: WorkspaceId;
  readonly draftId: AiDraftId;
  /** One logical outbound action per draft; stable across queue retries (ADR-012). */
  readonly operationId: OperationId;
  readonly correlationId: CorrelationId;
  readonly status: DeliveryJobStatus;
  readonly scheduledFor: Date;
  readonly selectedDelayMs: number;
  readonly attemptCount: number;
  readonly claimedAt?: Date;
  readonly sentAt?: Date;
  readonly cancelledAt?: Date;
  readonly platformMessageId?: string;
  readonly providerRequestId?: string;
  readonly lastError?: DeliveryError;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
