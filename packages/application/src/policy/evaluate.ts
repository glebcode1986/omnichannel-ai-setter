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
  nextQuietHoursEnd,
  type ReasonCode,
  type ReviewMode,
} from "@omnichannel/domain";

import type { PolicyDecision, PolicyInput } from "./inputs";

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
  if (!allowsAutomatedSend(input.takeover)) {
    if (input.takeover.state === "HUMAN_ACTIVE") {
      // A human owns the conversation (ADR-004). Queueing a review item would compete with the person
      // already handling it.
      reasons.add("HUMAN_TAKEOVER");
      terminal = true;
    } else {
      reasons.add("REVIEW_PENDING");
    }
  }

  // --- Everything below blocks an automatic send but still deserves a human's attention ----------------
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
  if (input.outboundSuspended !== undefined) {
    // Held rather than cancelled: the operator stopped sending, they did not decide the reply was wrong.
    // Held rather than skipped, too — the work stays recoverable for when the switch is lifted.
    reasons.add("AUTOMATION_SUSPENDED");
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
  // Quiet hours prefer to defer rather than block (product-owner decision on PR #67). A compliant later
  // time is a better answer than a review item — but only if it still sits inside what the provider
  // permits. On a channel with a seconds-long automated budget it never will, and then a person decides.
  const deferral = evaluateQuietHours(input);
  if (deferral.blocked) {
    reasons.add("QUIET_HOURS");
  }

  const windowReasons = evaluateWindowGate(input);
  for (const code of windowReasons) {
    reasons.add(code);
  }
  if (windowReasons.includes("WINDOW_CLOSED") && !reasons.has("HUMAN_AGENT_REVIEW_REQUIRED")) {
    // No permitted send path exists, now or by a human (product-owner decision on PR #67). A review item
    // here would be one nobody could act on, and a queue full of those is worse than an empty one — the
    // Inbox still shows the conversation with its operational state.
    terminal = true;
  }

  if (terminal) {
    return { action: "SKIP", reasons: ordered(reasons) };
  }
  if (reasons.size > 0) {
    return { action: "HOLD_REVIEW", reasons: ordered(reasons), reviewMode: reviewModeFor(input, reasons) };
  }
  return { action: "SCHEDULE", reasons: [], ...(deferral.notBefore === undefined ? {} : { notBefore: deferral.notBefore }) };
}

/**
 * Quiet hours, as a deferral preference rather than a prohibition.
 *
 * Outside quiet hours nothing changes. Inside them there is a compliant later time — the end of the quiet
 * period — and delivery is moved to it *if* that time is still within the provider's dispatch deadline and
 * the messaging window. If it is not, the reply cannot be sent late and cannot be sent now, so it becomes a
 * decision for a person. Quiet hours must never cause a blind late send.
 */
function evaluateQuietHours(input: PolicyInput): { readonly blocked: boolean; readonly notBefore?: Date } {
  const quietHours = input.limits.quietHours;
  if (quietHours === undefined || !isWithinQuietHours(quietHours, input.now)) {
    return { blocked: false };
  }
  const resumesAt = nextQuietHoursEnd(quietHours, input.now);
  if (input.dispatchDeadline !== undefined && resumesAt.getTime() > input.dispatchDeadline.getTime()) {
    // Waiting would miss the provider's own budget, and sending late is not an option.
    return { blocked: true };
  }
  if (input.window.state === "OPEN_FREEFORM" && input.window.expiresAt !== undefined && resumesAt.getTime() >= input.window.expiresAt.getTime()) {
    // The messaging window closes before the quiet period ends, so there is no compliant later time.
    return { blocked: true };
  }
  return { blocked: false, notBefore: resumesAt };
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
  if (humanAgentPathAvailable(input)) {
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
 * A review mode is a promise to the operator about which button will work. `HUMAN_AGENT` is therefore
 * offered only while the path is actually usable *right now*: the business must have chosen the extended
 * policy, and the provider exception must still be live.
 *
 * An existing `HUMAN_AGENT` review claim does not survive the exception expiring. Keeping it would show a
 * send path that the adapter re-checks and refuses at dispatch, which turns a stale decision into a dead
 * end the operator only discovers by clicking it.
 */
function reviewModeFor(input: PolicyInput, reasons: ReadonlySet<ReasonCode>): ReviewMode {
  if (!humanAgentPathAvailable(input)) {
    return "NORMAL";
  }
  const alreadyClaimed = input.takeover.state === "REVIEW_REQUIRED" && input.takeover.reviewMode === "HUMAN_AGENT";
  return alreadyClaimed || reasons.has("HUMAN_AGENT_REVIEW_REQUIRED") ? "HUMAN_AGENT" : "NORMAL";
}

function humanAgentPathAvailable(input: PolicyInput): boolean {
  const afterWindow = input.limits.afterWindow;
  // The human-support exception is Instagram's, and the union is what keeps it from being reachable on a
  // channel whose policy vocabulary does not contain it.
  return afterWindow.channel === "INSTAGRAM" && afterWindow.policy === "HUMAN_ASSISTED_EXTENDED" && input.humanAgent.state === "ELIGIBLE";
}

/**
 * A stable order, so two runs of the same input produce identical audit rows and a test can compare the
 * whole list rather than sorting at every call site.
 */
function ordered(reasons: ReadonlySet<ReasonCode>): readonly ReasonCode[] {
  return [...reasons].sort();
}
