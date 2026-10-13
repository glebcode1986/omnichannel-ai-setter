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
 *
 * And one that decides what the answer even means: **the question is whether this reply may be sent on this
 * authority**, not whether automation may send it. Most of the gates here exist to ask for a human; when a
 * human has already answered — approved a draft in the review queue, with their name and the moment on it —
 * those gates have had their answer and it would be absurd for them to hold the reply the person asked for.
 *
 * What an approval cannot answer is anything about what is *possible or permitted*: whether the provider's
 * window is still open, whether the customer has written since, whether the account can send at all,
 * whether the channel can carry the content. A click does not reopen a messaging window. Every one of those
 * stays in force, and the handful that a person does answer is written out gate by gate below rather than
 * subtracted from the result afterwards — a list of reasons to forgive would quietly forgive a new gate
 * nobody thought about.
 */
import {
  allowsAutomatedSend,
  isWithinQuietHours,
  nextQuietHoursEnd,
  takeoverAuthorizes,
  type ReasonCode,
  type ReviewMode,
  type SendAuthority,
} from "@omnichannel/domain";

import type { PolicyDecision, PolicyInput } from "./inputs";

export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  const reasons = new Set<ReasonCode>();
  /** The approval this send carries, if any. Absent means automation, and automation is judged strictly. */
  const approved = approvalIn(input.authority);
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
  if (!allowsAutomatedSend(input.takeover) && !(approved !== undefined && takeoverAuthorizes(input.takeover, approved))) {
    // Approving a reply takes the conversation, so the approver's own ownership cannot be what blocks it.
    // Anyone else's is: they hold the conversation now, and an approval from before that does not reach
    // past them.
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
  if (input.mode === "DRAFT" && approved === undefined) {
    // DRAFT always holds: the whole point of the mode is that a person sees every reply first — and once
    // one has, holding it again is the mode defeating itself.
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
    //
    // Unconditional, like the account check above it. A kill switch is not a request for someone to look;
    // it is an operator saying nothing may leave, and an approval recorded before they said it cannot
    // answer it. Making this one authority-aware would be building the path around the switch.
    reasons.add("AUTOMATION_SUSPENDED");
  }
  // --- Commercial access (#40, BILLING_ENTITLEMENTS.md) ----------------------------------------------
  //
  // Three separate facts, because they are three different conversations with the business: pay, change
  // plan, or wait. Each holds the reply for a person rather than ending it, so nothing is lost — the spec
  // is explicit that a workspace resumes from retained state once it pays, and a cancelled reply would
  // have nothing to resume.
  //
  // Authority-aware, unlike the kill switch above. What the spec stops is "paid AI generation, automation
  // and transcription"; a colleague answering their own customer from the Inbox is none of those, and a
  // failed card that silenced a business's own staff would contradict the same spec's insistence that the
  // workspace stays usable and its conversations answerable. So an approval answers these gates, and the
  // manual handling path is exactly what they leave open.
  if (approved === undefined && !input.commercial.paidWorkAllowed) {
    reasons.add("BILLING_INACTIVE");
  }
  if (approved === undefined && !input.commercial.aiDrafts) {
    // Reached only by a draft that was generated before a downgrade — generation itself is refused
    // earlier, where it costs a provider call. Checked anyway: a gate that trusts an upstream layer to
    // have already checked is not a gate.
    reasons.add("BILLING_FEATURE_OFF");
  }
  if (approved === undefined && input.mode === "AUTOPILOT" && !input.commercial.autopilot) {
    // The business set AUTOPILOT on a plan that does not sell it. `MODE_NOT_AUTOPILOT` would be false
    // here — the mode *is* autopilot — so the reason says what is actually true, and the reply waits for
    // a person exactly as it would in DRAFT.
    reasons.add("BILLING_FEATURE_OFF");
  }
  // --- Staged rollout (#60, LAUNCH_READINESS.md §18) -------------------------------------------------
  //
  // One more reason a reply may not go out unattended, in a product that is mid-rollout. It only ever
  // subtracts: the plan's feature, the profile's mode and the kill switch all still apply, and nothing
  // here can grant unattended sending to a profile the others refused.
  //
  // Authority-aware, and that is not a softening — it is what makes the gate usable. Stages one to three
  // of §18 *are* human-approved sending ("limited design partners, DRAFT-first"), so an unconditional
  // gate would block the very traffic those stages consist of, which is the `AUTOMATION_SUSPENDED` shape
  // above applied where it does not belong. Non-terminal for the same reason: the reply waits for a
  // person exactly as it would in DRAFT, and nothing is lost.
  //
  // It is worth saying why this is the opposite treatment from the kill switch, since both are operator
  // statements about the product rather than about this conversation. A kill switch is an *incident*: the
  // whole point is that outbound stops now, including replies a colleague approved a minute ago, because
  // whoever pulled it does not yet know what is wrong. A rollout stage is a *plan*: it says which
  // customers may have the product send on their behalf without anybody watching, and it has nothing to
  // say about a colleague answering their own customer. The consequence is deliberate — an approval
  // recorded before a rollout was pulled back still sends — and it is the right one: if the reason for
  // pulling back is that sending is unsafe at all, the tool for that is the switch, which is immediate,
  // unconditional and needs no reviewer.
  if (approved === undefined && input.mode === "AUTOPILOT" && !input.rollout.autopilot) {
    reasons.add("ROLLOUT_AUTOPILOT_NOT_RELEASED");
  }
  // The four below are all the same kind of gate: "a person should look at this". A person has, so they
  // are not asked again. What the person could not have changed — the account, the kill switch, the
  // channel's capabilities, the window — is checked above and below regardless of who is sending.
  if (approved === undefined && input.draft.confidence < input.limits.confidenceThreshold) {
    reasons.add("LOW_CONFIDENCE");
  }
  if (approved === undefined) {
    for (const code of mandatoryReviewReasons(input)) {
      reasons.add(code);
    }
  }
  if (approved === undefined && !input.retrieval.corpusReachable) {
    // "No such fact" and "we could not look" are different answers, and only the first may reach a customer.
    reasons.add("RETRIEVAL_UNAVAILABLE");
  }
  if (approved === undefined && !citationsSupported(input)) {
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
  // Quiet hours bound *automation*: they are the business's answer to "do not message people at night on
  // our behalf". A person choosing to reply at 03:00 has made that decision themselves, and deferring them
  // until morning would be this layer overruling the human it exists to serve.
  const deferral = approved === undefined ? evaluateQuietHours(input) : { blocked: false, notBefore: undefined };
  if (deferral.blocked) {
    reasons.add("QUIET_HOURS");
  }

  const windowReasons = evaluateWindowGate(input, approved);
  for (const code of windowReasons) {
    reasons.add(code);
  }
  if (windowReasons.includes("WINDOW_CLOSED") && !reasons.has("HUMAN_AGENT_REVIEW_REQUIRED") && !reasons.has("TEMPLATE_REQUIRED")) {
    // No permitted send path exists, now or by a human (product-owner decision on PR #67). A review item
    // here would be one nobody could act on, and a queue full of those is worse than an empty one — the
    // Inbox still shows the conversation with its operational state.
    //
    // `TEMPLATE_REQUIRED` joins the human-agent exception as a path a person *can* take: outside
    // WhatsApp's service window an approved template still reaches the customer (ADR-016), so asking for
    // one is a review item somebody can resolve. `NO_ELIGIBLE_TEMPLATE` deliberately is not — it means
    // there is no approved template to resolve it with.
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

/** The human variant of `SendAuthority`, narrowed once so every gate can ask the same short question. */
type HumanApproval = Extract<SendAuthority, { kind: "HUMAN_APPROVED" }>;

function approvalIn(authority: SendAuthority | undefined): HumanApproval | undefined {
  return authority?.kind === "HUMAN_APPROVED" ? authority : undefined;
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
function evaluateWindowGate(input: PolicyInput, approved: HumanApproval | undefined): readonly ReasonCode[] {
  if (isWindowOpen(input)) {
    return [];
  }
  const templateRoute = evaluateTemplateGate(input, approved);
  if (templateRoute !== undefined) {
    return templateRoute;
  }
  if (humanAgentPathAvailable(input)) {
    // The AI may draft; only a deliberate human action may initiate the tagged send. An approval that named
    // the human-agent path *is* that action, and nothing else is: an approval of an ordinary reply has not
    // agreed to a tagged send, and automation can never produce one at all. So this returns a review path
    // rather than a schedule for everyone else.
    return approved?.reviewMode === "HUMAN_AGENT" ? [] : ["WINDOW_CLOSED", "HUMAN_AGENT_REVIEW_REQUIRED"];
  }
  // Includes HUMAN_ASSISTED_EXTENDED when Human Agent is expired, unapproved or unknown: eligibility is
  // never assumed, and an absent approval is not a weaker form of approval.
  return ["WINDOW_CLOSED"];
}

/**
 * The WhatsApp outside-window template route (ADR-016).
 *
 * `undefined` means this channel and this policy have no template route, and the caller falls through to
 * the window gate it had before — so a business that chose `SERVICE_WINDOW_ONLY` is in exactly the
 * position it was in before this existed: automation stops until the customer writes again.
 *
 * Four things decide the answer, and each is a different sentence to the operator.
 *
 * **The window must be `TEMPLATE_ONLY`.** `NOT_ELIGIBLE` and `UNKNOWN` never get a template route:
 * the first is the provider saying this recipient or account may not be messaged at all, and the second
 * is us not knowing, which fails closed everywhere else in this file and must fail closed here.
 *
 * **There must be an approved template to send.** Without one the matter ends, because a review item
 * asking a person to pick from nothing is one they cannot resolve.
 *
 * **The content must *be* a template.** A free-form draft composed while the window was open and
 * dispatched after it closed cannot be sent whoever approved it: approving words is not approving a
 * template, and no click reopens a messaging window.
 *
 * **Unattended sending needs the allowlist.** `TEMPLATE_AUTOPILOT` with nothing allowlisted sends nothing
 * on its own — ADR-016 is explicit — and a human approval of this very template send is the other way
 * through. In `TEMPLATE_REVIEW` only the second exists, which is the whole of that mode.
 */
function evaluateTemplateGate(input: PolicyInput, approved: HumanApproval | undefined): readonly ReasonCode[] | undefined {
  const afterWindow = input.limits.afterWindow;
  if (afterWindow.channel !== "WHATSAPP" || afterWindow.policy === "SERVICE_WINDOW_ONLY") {
    return undefined;
  }
  if (input.window.state !== "TEMPLATE_ONLY") {
    return undefined;
  }
  if (input.templateRoute === undefined || !input.templateRoute.approvedTemplateAvailable) {
    return ["WINDOW_CLOSED", "NO_ELIGIBLE_TEMPLATE"];
  }
  if (input.draft.contentType !== "TEMPLATE") {
    return ["WINDOW_CLOSED", "TEMPLATE_REQUIRED"];
  }
  if (approved !== undefined) {
    // A person approved this template, with these values, after seeing them. That is the authorized human
    // act ADR-016 asks for, and it is the only thing that can authorize a send in `TEMPLATE_REVIEW`.
    return [];
  }
  return afterWindow.policy === "TEMPLATE_AUTOPILOT" && input.templateRoute.automatable ? [] : ["WINDOW_CLOSED", "TEMPLATE_REQUIRED"];
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
  if (afterWindow.channel !== "INSTAGRAM" || afterWindow.policy !== "HUMAN_ASSISTED_EXTENDED") {
    return false;
  }
  // `ELIGIBLE` is a fact about a moment, and it arrives here already computed — from an adapter call, a
  // cached row, a decision taken earlier in this pipeline. The same reasoning the window gate applies to
  // its own expiry applies here: a lapsed exception read as current offers a review path the adapter
  // re-checks and refuses at dispatch, which the operator discovers only by clicking it. An expiry
  // exactly at `now` has passed.
  return input.humanAgent.state === "ELIGIBLE" && input.humanAgent.expiresAt.getTime() > input.now.getTime();
}

/**
 * A stable order, so two runs of the same input produce identical audit rows and a test can compare the
 * whole list rather than sorting at every call site.
 */
function ordered(reasons: ReadonlySet<ReasonCode>): readonly ReasonCode[] {
  return [...reasons].sort();
}
