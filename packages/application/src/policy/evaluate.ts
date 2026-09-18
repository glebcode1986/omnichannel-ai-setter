/**
 * The deterministic policy engine (POLICY_ENGINE.md v0.2, ADR-004, ADR-014).
 *
 * This is the layer that decides whether an AI draft may be delivered automatically. Three properties shape
 * how it is written:
 *
 * 1. **Every gate is evaluated, not the first failing one.** A short-circuit would report "low confidence"
 *    and hide that the window was also closed, so the operator fixes one thing, retries, and meets the next
 *    wall. Reasons accumulate; the action is then derived from the set.
 * 2. **A gate can only ever add a reason.** No gate clears another's, and nothing in the draft — which is
 *    model output, however well validated — can remove one. The model's own `should_send` is not an input
 *    at all: it is advice, and advice is not a gate.
 * 3. **The distinction between "nobody needs to act" and "a person must act" is the decision.** `SKIP`
 *    means the work is over; `HOLD_REVIEW` means a human is expected. Getting that backwards either buries
 *    an operator in dead review items or silently drops a reply they wanted to send.
 */
import {
  allowsAutomatedSend,
  isWithinQuietHours,
  type ReasonCode,
  type ReviewMode,
} from "@omnichannel/domain";

import type { HumanAgentAvailability, PolicyDecision, PolicyInput } from "./inputs";

export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  const reasons = new Set<ReasonCode>();
  /**
   * Tracked as a flag rather than as a set of "terminal codes", because the same code can be terminal or
   * not: `MODE_NOT_AUTOPILOT` ends the matter in OFF and asks for a human in DRAFT.
   */
  let terminal = false;

  // --- Is there anything to act on at all? -----------------------------------------------------------
  if (input.mode === "OFF") {
    // OFF mirrors the conversation and never produces delivery, not even for review.
    reasons.add("MODE_NOT_AUTOPILOT");
    terminal = true;
  }
  if (!input.aiEnabled) {
    reasons.add("AI_DISABLED");
    terminal = true;
  }
  if (input.replyCycle === "SUPERSEDED") {
    // The customer has spoken since; this draft answers a question that has moved on.
    reasons.add("SUPERSEDED_BY_NEWER_INBOUND");
    terminal = true;
  }
  if (!allowsAutomatedSend(input.takeover) && input.takeover.state === "HUMAN_ACTIVE") {
    // A human owns the conversation (ADR-004). Queueing a review item would compete with the person
    // already handling it.
    reasons.add("HUMAN_TAKEOVER");
    terminal = true;
  }

  // --- Everything below blocks an automatic send but still deserves a human's attention ----------------
  if (input.takeover.state === "REVIEW_REQUIRED") {
    reasons.add("REVIEW_PENDING");
  }
  if (input.mode === "DRAFT") {
    // DRAFT always holds: the whole point of the mode is that a person sees every reply first.
    reasons.add("MODE_NOT_AUTOPILOT");
  }
  if (!input.draft.usable) {
    // A generation whose output could not be used is stored for audit and can never be scheduled.
    reasons.add("INVALID_MODEL_OUTPUT");
  }
  if (input.account !== "CONNECTED") {
    reasons.add("ACCOUNT_UNHEALTHY");
  }
  if (input.draft.confidence < input.limits.confidenceThreshold) {
    reasons.add("LOW_CONFIDENCE");
  }
  for (const code of mandatoryReviewReasons(input)) {
    reasons.add(code);
  }
  if (!input.retrieval.corpusReachable) {
    // "No such fact" and "we could not look" are different answers, and only the first may reach a customer.
    reasons.add("RETRIEVAL_UNAVAILABLE");
  }
  if (!citationsSupported(input)) {
    // Re-checked here rather than trusted from the draft engine: a gate that relies on an upstream layer
    // having already checked is not a gate.
    reasons.add("MISSING_FACT");
  }
  if (!contentSupported(input)) {
    reasons.add("UNSUPPORTED_MEDIA");
  }
  if (input.limits.quietHours !== undefined && isWithinQuietHours(input.limits.quietHours, input.now)) {
    // Deferring past quiet hours is not an option on a channel with a seconds-long automated budget
    // (Issue #13 owner decision), so quiet hours mean a person decides, not a later robot.
    reasons.add("QUIET_HOURS");
  }

  const windowReasons = evaluateWindowGate(input);
  for (const code of windowReasons) {
    reasons.add(code);
  }

  if (terminal) {
    return { action: "SKIP", reasons: ordered(reasons) };
  }
  if (reasons.size > 0) {
    return { action: "HOLD_REVIEW", reasons: ordered(reasons), reviewMode: reviewModeFor(input, reasons) };
  }
  return { action: "SCHEDULE", reasons: [] };
}

/**
 * The window gate, and the Instagram after-window policy (ADR-014).
 *
 * `UNKNOWN` fails closed: an unknown window is not an open one, and the cost of guessing wrong is a message
 * sent outside what the provider permits.
 */
function evaluateWindowGate(input: PolicyInput): readonly ReasonCode[] {
  if (isWindowOpen(input)) {
    return [];
  }
  if (input.limits.instagramAfterWindowPolicy === "HUMAN_ASSISTED_EXTENDED" && input.humanAgent.state === "ELIGIBLE") {
    // The AI may draft; only a deliberate human action may initiate the tagged send. This layer therefore
    // returns a review path and never a schedule — no automated delivery may carry HUMAN_AGENT.
    return ["WINDOW_CLOSED", "HUMAN_AGENT_REVIEW_REQUIRED"];
  }
  // Includes HUMAN_ASSISTED_EXTENDED when Human Agent is expired, unapproved or unknown: eligibility is
  // never assumed, and an absent approval is not a weaker form of approval.
  return ["WINDOW_CLOSED"];
}

function isWindowOpen(input: PolicyInput): boolean {
  if (input.window.state !== "OPEN_FREEFORM") {
    return false;
  }
  // An expiry already in the past is a closed window whatever the state says: the decision may have been
  // computed a moment ago, and a stale "open" is exactly the race that sends a message out of window.
  return input.window.expiresAt === undefined || input.window.expiresAt.getTime() > input.now.getTime();
}

/** Only categories the business marked mandatory, intersected with what this draft actually carries. */
function mandatoryReviewReasons(input: PolicyInput): readonly ReasonCode[] {
  const mandatory = new Set<ReasonCode>(input.limits.mandatoryReviewReasons);
  return input.draft.reasonCodes.filter((code) => mandatory.has(code));
}

/** A citation the model was never given is not support; it is invention with a reference attached. */
function citationsSupported(input: PolicyInput): boolean {
  const supplied = new Set(input.retrieval.suppliedSourceIds);
  return input.draft.citedSourceIds.every((id) => supplied.has(id));
}

function contentSupported(input: PolicyInput): boolean {
  return input.draft.contentType === "TEXT" ? input.capabilities.text : input.capabilities.templates;
}

/**
 * `HUMAN_AGENT` only where a human-support exception is genuinely available, or where the conversation is
 * already held under one. Everything else is a normal review.
 */
function reviewModeFor(input: PolicyInput, reasons: ReadonlySet<ReasonCode>): ReviewMode {
  if (input.takeover.state === "REVIEW_REQUIRED" && input.takeover.reviewMode === "HUMAN_AGENT") {
    return "HUMAN_AGENT";
  }
  return reasons.has("HUMAN_AGENT_REVIEW_REQUIRED") && isHumanAgentEligible(input.humanAgent) ? "HUMAN_AGENT" : "NORMAL";
}

function isHumanAgentEligible(availability: HumanAgentAvailability): boolean {
  return availability.state === "ELIGIBLE";
}

/**
 * A stable order, so two runs of the same input produce identical audit rows and a test can compare the
 * whole list rather than sorting at every call site.
 */
function ordered(reasons: ReadonlySet<ReasonCode>): readonly ReasonCode[] {
  return [...reasons].sort();
}
