/**
 * Versioned, runtime-validated job payloads. Payloads carry stable identifiers and correlation data only —
 * never message text or other conversation content, which workers load from PostgreSQL when they run.
 */
import { isValidIdentifier, RECONCILIATION_REASONS } from "@omnichannel/domain";
import { z } from "zod";

export const MAX_SCHEDULE_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

const identifier = z.string().max(255).refine(isValidIdentifier, { message: "invalid identifier" });
const timestamp = z.iso.datetime();

/**
 * Every payload names its Workspace and Business Profile (DATA_MODEL.md v0.4): execution scope and job
 * identity depend on both. The queue does not authorize anything; workers revalidate against PostgreSQL.
 */
const envelope = {
  schemaVersion: z.literal(1),
  workspaceId: identifier,
  businessProfileId: identifier,
  /** Propagated through enqueue/process logs and downstream work (observability). */
  correlationId: identifier,
};

/** Stage A: fires after the debounce window of the newest inbound message in a burst (DELAY_ENGINE.md). */
export const inboundDebounceJobSchema = z.strictObject({
  ...envelope,
  channelAccountId: identifier,
  conversationId: identifier,
  /** Newest inbound message of the burst; it owns the reply cycle. */
  anchorMessageId: identifier,
  /** Platform time of the anchor message; later inbound messages supersede earlier anchors. */
  anchorInboundAt: timestamp,
});
export type InboundDebounceJob = z.output<typeof inboundDebounceJobSchema>;

export const AI_DRAFT_TRIGGERS = ["AUTOMATIC", "HUMAN_REQUEST"] as const;

/**
 * Why the draft was asked for, and on whose authority.
 *
 * A discriminated union rather than a flag plus optional fields: mode OFF permits a draft only when an
 * authorized person asked for it, so "a human asked" must be impossible to express without naming the
 * person. An inbound-triggered job has no user to name, so it cannot produce the human variant even by
 * accident, and the schema rejects one that tries.
 */
export const aiDraftTriggerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("AUTOMATIC"), reason: z.literal("DEBOUNCE_ELAPSED") }),
  z.strictObject({
    kind: z.literal("HUMAN_REQUEST"),
    requestedByUserId: identifier,
    requestedAt: timestamp,
    /** Each explicit request is its own generation; a retried job reuses this value. */
    requestId: identifier,
  }),
  z.strictObject({
    /**
     * A scheduled follow-up attempt asking for a reply (#55).
     *
     * It names the attempt rather than only the follow-up, because the attempt is what identifies the
     * work: the anchor is the same message every time a follow-up chases one silence, so an
     * anchor-keyed job would make a second allowed attempt the same job as the first and quietly drop it.
     *
     * It carries no user, like `AUTOMATIC` and unlike `HUMAN_REQUEST`: a follow-up is automation, and mode
     * OFF, a takeover and a pending review all stop it.
     */
    kind: z.literal("FOLLOW_UP"),
    followUpId: identifier,
    attempt: z.number().int().min(1).max(5),
  }),
]);

export const aiDraftGenerationJobSchema = z.strictObject({
  ...envelope,
  conversationId: identifier,
  anchorMessageId: identifier,
  trigger: aiDraftTriggerSchema,
});
export type AiDraftGenerationJob = z.output<typeof aiDraftGenerationJobSchema>;

/** Stage B: delayed delivery of one logical outbound action (ADR-003, ADR-012). */
export const deliveryJobSchema = z.strictObject({
  ...envelope,
  conversationId: identifier,
  /**
   * The AI draft this send came from, absent when a person composed it themselves (ADR-018 Option B).
   *
   * Optional rather than a placeholder: `operationId` and `deliveryJobId` already identify the work, and
   * a job carrying an invented draft id would have the worker log and reconcile against a row that does
   * not exist. The send path is the same either way — that is the point of the decision.
   */
  draftId: identifier.optional(),
  /** DeliveryJobRecord row that owns the durable delivery state. */
  deliveryJobId: identifier,
  /** Stable idempotency identity of the outbound action; identical across retries and restarts. */
  operationId: identifier,
  /** Intended send time, recorded for audit alongside the selected delay. */
  scheduledFor: timestamp,
  selectedDelayMs: z.number().int().min(0).max(MAX_SCHEDULE_DELAY_MS),
});
export type DeliveryJob = z.output<typeof deliveryJobSchema>;


/** Follow-up for an outbound action whose outcome is unknown. Never a resend (ADR-012). */
export const reconciliationJobSchema = z.strictObject({
  ...envelope,
  conversationId: identifier,
  deliveryJobId: identifier,
  operationId: identifier,
  reason: z.enum(RECONCILIATION_REASONS),
  detectedAt: timestamp,
  providerRequestId: identifier.optional(),
  providerCode: z.string().max(255).optional(),
});
export type ReconciliationJob = z.output<typeof reconciliationJobSchema>;

export interface PayloadIssue {
  readonly path: string;
  readonly code: string;
}

/** Invalid job payload. Reports field paths and issue codes only, never payload values. */
export class JobPayloadValidationError extends Error {
  readonly jobName: string;
  readonly issues: readonly PayloadIssue[];

  constructor(jobName: string, issues: readonly PayloadIssue[]) {
    super(`Invalid ${jobName} payload: ${issues.map((issue) => `${issue.path || "(root)"} [${issue.code}]`).join("; ")}`);
    this.name = "JobPayloadValidationError";
    this.jobName = jobName;
    this.issues = issues;
  }
}

export function parsePayload<T>(schema: z.ZodType<T>, jobName: string, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new JobPayloadValidationError(
      jobName,
      result.error.issues.map((issue) => ({ path: issue.path.map(String).join("."), code: issue.code })),
    );
  }
  return result.data;
}
