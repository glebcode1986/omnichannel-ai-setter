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
  // commercial access (#40, BILLING_ENTITLEMENTS.md)
  //
  // Three codes rather than one, because they call for three different actions from whoever reads them:
  // pay, change plan, or wait. Collapsing them into a single "billing" reason would put an operator in
  // front of a message that cannot tell them which of the three they are looking at.
  /**
   * This workspace may not do paid work right now: no subscription, or past trial and past grace.
   *
   * Answered by paying. Deliberately not a claim about the plan's contents — a workspace on the best plan
   * in the catalogue carries this the day after its card fails.
   */
  "BILLING_INACTIVE",
  /**
   * The plan does not include the feature this send needs.
   *
   * Answered by changing plan, which is a different conversation from paying an overdue invoice. The
   * server decides it: a business that set AUTOPILOT on a plan that does not sell it gets its replies
   * held for a person rather than sent, however the screen looked when they chose.
   */
  "BILLING_FEATURE_OFF",
  /**
   * An explicitly metered allowance is spent.
   *
   * Answered by waiting for the cycle or by topping up, and never by inventing the thing that could not
   * be paid for: a recording nobody could afford to transcribe does not become a reply written as though
   * it had been heard. Core AI replies cannot produce this code, because the initial plans do not meter
   * them (USAGE_METERING.md).
   */
  "BILLING_LIMIT",
  /**
   * The staged rollout has not released unattended sending for this Business Profile yet (#60, §18).
   *
   * Answered by the rollout reaching the next stage, or by somebody adding this profile to the explicit
   * list the limited stage runs on — not by the business doing anything, which is why it is its own code
   * rather than a billing or a mode reason. A business reading `MODE_NOT_AUTOPILOT` would go and check a
   * setting that is already correct.
   *
   * Holds the reply for a person rather than ending it, and is answered by an approval. That is not a
   * softening: stages one to three of the rollout *are* human-approved sending, so a gate that a person
   * could not answer would make the limited rollout unusable rather than careful.
   */
  "ROLLOUT_AUTOPILOT_NOT_RELEASED",
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
