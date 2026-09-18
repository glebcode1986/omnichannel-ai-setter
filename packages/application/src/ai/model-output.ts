/**
 * The boundary between a language model and this system (ADR-010, AI_BEHAVIOR.md).
 *
 * Everything a model produces is untrusted until it parses here. The schema is strict on purpose: an extra
 * key is a failure, not something to ignore, so output that tries to ask for an action — a tool call, a
 * "send" instruction, a different shape — is rejected rather than partially honoured.
 */
import { LEAD_STAGES, MANDATORY_REVIEW_REASON_CODES, type ReasonCode } from "@omnichannel/domain";
import { z } from "zod";

/**
 * Codes a model may emit. Deliberately a subset: the deterministic gates (`HUMAN_TAKEOVER`, `WINDOW_CLOSED`,
 * `RATE_LIMITED`, ...) are facts the system establishes, and a model claiming one would poison the audit
 * trail. `INVALID_MODEL_OUTPUT` is ours to set, never the model's.
 */
export const MODEL_EMITTABLE_REASON_CODES = [
  "LOW_CONFIDENCE",
  "MISSING_FACT",
  "UNSUPPORTED_MEDIA",
  "UNSUPPORTED_CONTENT",
  ...MANDATORY_REVIEW_REASON_CODES,
] as const satisfies readonly ReasonCode[];

export const MODEL_OUTPUT_SCHEMA_VERSION = "ai-draft.v1";

/** Bounded so a runaway generation cannot become a runaway message or a runaway row. */
const MAX_REPLY_CHARS = 4_000;

export const aiDraftOutputSchema = z.strictObject({
  reply: z.string().min(1).max(MAX_REPLY_CHARS),
  /** Bounded here so the domain's `toConfidence` can never throw after a successful parse. */
  confidence: z.number().min(0).max(1),
  /** Advisory only. The policy engine decides sending; this flag alone can never cause one. */
  should_send: z.boolean(),
  needs_review: z.boolean(),
  reason_codes: z.array(z.enum(MODEL_EMITTABLE_REASON_CODES)).max(16),
  intent: z.string().min(1).max(64).nullable(),
  lead_stage: z.enum(LEAD_STAGES).nullable(),
  suggested_action: z.string().max(280).nullable(),
  /** IDs of knowledge chunks actually relied on; style examples never belong here. */
  factual_source_ids: z.array(z.string().min(1).max(255)).max(32),
});

export type AiDraftOutput = z.output<typeof aiDraftOutputSchema>;

export interface ModelOutputIssue {
  readonly path: string;
  readonly code: string;
}

export type ModelOutputParse =
  | { readonly ok: true; readonly value: AiDraftOutput }
  | { readonly ok: false; readonly issues: readonly ModelOutputIssue[] };

/**
 * Validates model output. Failures carry field paths and issue codes only — never the model's text, which
 * may quote a customer. There is no lenient mode and no hand-rolled JSON repair: malformed output gets
 * exactly one regeneration attempt upstream and is then held for review.
 */
export function parseModelOutput(output: unknown): ModelOutputParse {
  const result = aiDraftOutputSchema.safeParse(output);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({ path: issue.path.map(String).join("."), code: issue.code })),
  };
}
