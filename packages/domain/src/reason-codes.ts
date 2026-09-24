import { literalGuard } from "./enum";

/**
 * Normalized reasons attached to AI drafts and policy/review decisions (AI_BEHAVIOR.md, POLICY_ENGINE.md).
 * Codes are stable identifiers; human-readable text lives in the UI.
 */
export const REASON_CODES = [
  // model/draft quality
  "LOW_CONFIDENCE",
  "MISSING_FACT",
  "INVALID_MODEL_OUTPUT",
  "UNSUPPORTED_MEDIA",
  "UNSUPPORTED_CONTENT",
  // mandatory-review categories
  "PAYMENT_DISPUTE",
  "LEGAL_INTERPRETATION",
  "MEDICAL_OR_HIGH_RISK",
  "CREDENTIAL_OR_SECURITY",
  "REPUTATIONAL_COMPLAINT",
  "HIGH_VALUE_COMMITMENT",
  "UNSUPPORTED_PROMISE",
  // deterministic gates
  "MODE_NOT_AUTOPILOT",
  "AI_DISABLED",
  "HUMAN_TAKEOVER",
  "REVIEW_PENDING",
  "WINDOW_CLOSED",
  "HUMAN_AGENT_REVIEW_REQUIRED",
  "TEMPLATE_REQUIRED",
  "ACCOUNT_UNHEALTHY",
  "QUIET_HOURS",
  "RATE_LIMITED",
  "SUPERSEDED_BY_NEWER_INBOUND",
  "RETRIEVAL_UNAVAILABLE",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];
export const isReasonCode = literalGuard(REASON_CODES);

/** Categories that always require human review before any send (AI_BEHAVIOR.md). */
export const MANDATORY_REVIEW_REASON_CODES = [
  "MISSING_FACT",
  "PAYMENT_DISPUTE",
  "LEGAL_INTERPRETATION",
  "MEDICAL_OR_HIGH_RISK",
  "CREDENTIAL_OR_SECURITY",
  "REPUTATIONAL_COMPLAINT",
  "HIGH_VALUE_COMMITMENT",
  "UNSUPPORTED_PROMISE",
  "UNSUPPORTED_MEDIA",
] as const satisfies readonly ReasonCode[];
