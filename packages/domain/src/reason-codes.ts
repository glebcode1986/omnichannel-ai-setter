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
  /** Outside the customer-service window an approved template is the only route; this send is not one. */
  "TEMPLATE_REQUIRED",
  /**
   * There is no approved template this account could send at all, so no person can act either.
   *
   * Distinct from `TEMPLATE_REQUIRED`, which asks for a human: this one ends the matter. A review item
   * nobody can resolve is worse than an empty queue, and Meta pauses, disables and finally archives
   * templates on its own, so a catalogue that offered a route yesterday may offer none today.
   */
  "NO_ELIGIBLE_TEMPLATE",
  "ACCOUNT_UNHEALTHY",
  "QUIET_HOURS",
  "RATE_LIMITED",
  "SUPERSEDED_BY_NEWER_INBOUND",
  "RETRIEVAL_UNAVAILABLE",
  /**
   * The burst this draft answers contains a recording the product could not read (Issue #21).
   *
   * Deliberately not `UNSUPPORTED_MEDIA`, which already means something else: that the *outbound* channel
   * cannot carry the content of a reply. Conflating them would make an audit unable to tell "we could not
   * hear the customer" from "we could not send what we wrote", and those call for different fixes.
   *
   * Like `RETRIEVAL_UNAVAILABLE`, it is set by this codebase rather than by a model — a model cannot know
   * a download failed — and it holds the draft for a person. Replying to a voice note nobody heard is the
   * invented content this exists to prevent.
   */
  "AUDIO_NOT_TRANSCRIBED",
  /** An operator, or the system on their behalf, stopped automated outbound for this scope. */
  "AUTOMATION_SUSPENDED",
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
