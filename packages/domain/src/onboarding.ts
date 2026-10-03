/**
 * Onboarding readiness and the activation checklist (ONBOARDING_UX.md, Issue #27).
 *
 * Nothing here is stored. `BusinessProfile` says it outright — status is not operational readiness, and
 * readiness is evaluated at execution time — so this module is a pure function of facts read now. That is
 * also what makes onboarding resumable without a state machine: the completed steps *are* the
 * configuration, so a reload cannot lose them and a stored copy cannot drift from them.
 *
 * The one thing that cannot be derived is a deliberate skip. "Style configured **or intentionally
 * skipped**" is a decision a person made, and no amount of looking at the data reveals it, so that single
 * fact is passed in from persistence. Everything else is read from the profile's own configuration.
 *
 * The four channel states the spec insists on distinguishing are a ladder, not a set: each rung adds one
 * question, and a card can say exactly how far a channel got. "Eligible" is about this deployment's
 * standing permission to send; "sendable" is about whether anything is stopping it right now. Neither is
 * authoritative — the delivery coordinator re-checks both before any reply leaves (PRODUCT_UX.md).
 */
import { literalGuard } from "./enum";
import type { AiMode, ChannelType } from "./channel";
import type { ChannelAccountStatus } from "./channel-account";

/**
 * The onboarding sequence, in the order ONBOARDING_UX.md prescribes.
 *
 * `WORKSPACE` is complete by construction — a person cannot reach onboarding without a workspace and a
 * Business Profile — and it is kept in the list so the UI can show where the journey started rather than
 * opening on a step 2 with no step 1 above it.
 */
export const ONBOARDING_STEPS = [
  "WORKSPACE",
  "CHANNELS",
  "AI_BEHAVIOUR",
  "KNOWLEDGE",
  "STYLE",
  "TIMING_AND_HANDOFF",
  "CHANNEL_POLICY",
  "TEST_DRIVE",
  "ACTIVATION",
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export const isOnboardingStep = literalGuard(ONBOARDING_STEPS);

/**
 * Steps a person may decide not to do, and still launch.
 *
 * Deliberately short. A skippable step is one where "no" is a legitimate answer for a small business:
 * style can be left to the platform default, the recommended timing preset is a real choice a business can
 * make by not choosing, and the test drive is a reassurance rather than a requirement. Knowledge is not
 * here — a setter with no facts invents them — and neither is anything that decides whether a reply may be
 * sent at all.
 *
 * Timing is skippable for an honest reason rather than a convenient one: the product's defaults *are* its
 * "Natural" preset, so nothing in the data distinguishes a business that chose them from one that never
 * opened the step. Rather than invent a marker to fake that precision, the step asks to be either
 * customised or passed over, and both are recorded truthfully.
 */
export const SKIPPABLE_ONBOARDING_STEPS = ["STYLE", "TIMING_AND_HANDOFF", "TEST_DRIVE"] as const satisfies readonly OnboardingStep[];
export type SkippableOnboardingStep = (typeof SKIPPABLE_ONBOARDING_STEPS)[number];
export const isSkippableOnboardingStep = literalGuard(SKIPPABLE_ONBOARDING_STEPS);

/** How far one channel got. A ladder: each state implies the ones above it. */
export const CHANNEL_READINESS = ["NOT_CONFIGURED", "CONFIGURED", "CONNECTED", "ELIGIBLE", "SENDABLE"] as const;
export type ChannelReadiness = (typeof CHANNEL_READINESS)[number];

/** What one channel account looks like to the onboarding surface. Read now, never cached. */
export interface ChannelOnboardingFacts {
  readonly channel: ChannelType;
  readonly status: ChannelAccountStatus;
  /**
   * Whether the channel can carry a text reply at all.
   *
   * One boolean rather than the whole capability set, because that is the only capability question the
   * readiness ladder asks — and asking persistence for a typed `ChannelCapabilities` would mean casting a
   * JSON column into an interface, which is a promise the compiler cannot check.
   */
  readonly canCarryText: boolean;
  /** The effective automation mode for this account; `OFF` means nothing automated may go out. */
  readonly mode: AiMode;
  /**
   * Whether an operator's kill switch currently covers this account (Issue #56). It is the difference
   * between "could send" and "would send right now", and it is the reason `SENDABLE` exists separately.
   */
  readonly outboundSuspended: boolean;
}

export interface OnboardingFacts {
  /** Channel accounts belonging to this Business Profile, in whatever order persistence returned them. */
  readonly channels: readonly ChannelOnboardingFacts[];
  /** Whether an automation policy row exists: the profile has made its behaviour choices explicit. */
  readonly policyConfigured: boolean;
  /** Whether the timing and handoff choices have been made rather than left at defaults. */
  readonly timingConfigured: boolean;
  /** Whether the channel's own outside-window behaviour has been chosen where the channel has one. */
  readonly channelPolicyConfigured: boolean;
  readonly knowledgeDocumentCount: number;
  readonly styleConfigured: boolean;
  readonly testDriveCompleted: boolean;
  /** Review items nobody has resolved. A launch on top of these would start by ignoring them. */
  readonly blockingReviewItemCount: number;
  readonly activated: boolean;
}

export const ONBOARDING_STEP_STATES = ["COMPLETE", "SKIPPED", "INCOMPLETE"] as const;
export type OnboardingStepState = (typeof ONBOARDING_STEP_STATES)[number];

export interface OnboardingStepStatus {
  readonly step: OnboardingStep;
  readonly state: OnboardingStepState;
  /** True when a person may legitimately move past this step without doing it. */
  readonly skippable: boolean;
}

/** Why activation is not available yet, in the order a person should deal with them. */
export const ACTIVATION_BLOCKERS = [
  "NO_CONNECTED_CHANNEL",
  "NO_KNOWLEDGE",
  "STYLE_NOT_CONFIGURED",
  "NO_POLICY",
  "UNRESOLVED_REVIEW_ITEMS",
] as const;
export type ActivationBlocker = (typeof ACTIVATION_BLOCKERS)[number];

export interface OnboardingState {
  readonly steps: readonly OnboardingStepStatus[];
  /**
   * Where to resume: the first step that is neither complete nor deliberately skipped. `undefined` when
   * everything is done, which is the only case in which the journey is over.
   */
  readonly nextStep?: OnboardingStep;
  readonly activationBlockers: readonly ActivationBlocker[];
  readonly canActivate: boolean;
}

/** How far this channel got, as one of the ladder's rungs. */
export function channelReadiness(facts: ChannelOnboardingFacts): ChannelReadiness {
  if (facts.status !== "CONNECTED") {
    // A row exists, so the channel is configured; it just cannot be used until the person re-authorizes.
    return "CONFIGURED";
  }
  if (!facts.canCarryText || facts.mode === "OFF") {
    // Connected to the provider, but nothing automated may leave: either the channel cannot carry a reply
    // or the business has switched automation off. Both are states, not errors.
    return "CONNECTED";
  }
  return facts.outboundSuspended ? "ELIGIBLE" : "SENDABLE";
}

/**
 * The whole onboarding picture, evaluated from facts and the person's own skips.
 *
 * @param skipped steps the person deliberately passed over. Unskippable entries are ignored rather than
 * honoured: a stored skip for a step that must not be skipped is a bug or a tampered row, and the safe
 * reading of it is that the step is simply not done.
 */
export function evaluateOnboarding(facts: OnboardingFacts, skipped: readonly OnboardingStep[] = []): OnboardingState {
  const deliberatelySkipped = new Set<OnboardingStep>(skipped.filter((step) => isSkippableOnboardingStep(step)));
  const steps = ONBOARDING_STEPS.map((step): OnboardingStepStatus => {
    const skippable = isSkippableOnboardingStep(step);
    if (isStepComplete(step, facts)) {
      return { step, state: "COMPLETE", skippable };
    }
    return { step, state: deliberatelySkipped.has(step) ? "SKIPPED" : "INCOMPLETE", skippable };
  });

  const activationBlockers = blockersFor(facts, deliberatelySkipped);
  return {
    steps,
    ...(firstUnfinished(steps) === undefined ? {} : { nextStep: firstUnfinished(steps) }),
    activationBlockers,
    canActivate: activationBlockers.length === 0 && !facts.activated,
  };
}

function isStepComplete(step: OnboardingStep, facts: OnboardingFacts): boolean {
  switch (step) {
    case "WORKSPACE":
      // Reaching onboarding at all required a workspace and a Business Profile.
      return true;
    case "CHANNELS":
      // Configured is enough to have *done* the step: a channel awaiting re-authorization is a connection
      // problem to show, not an onboarding step to redo. Activation still asks for a connected one.
      return facts.channels.length > 0;
    case "AI_BEHAVIOUR":
      return facts.policyConfigured;
    case "KNOWLEDGE":
      return facts.knowledgeDocumentCount > 0;
    case "STYLE":
      return facts.styleConfigured;
    case "TIMING_AND_HANDOFF":
      return facts.timingConfigured;
    case "CHANNEL_POLICY":
      return facts.channelPolicyConfigured;
    case "TEST_DRIVE":
      return facts.testDriveCompleted;
    case "ACTIVATION":
      return facts.activated;
  }
}

function firstUnfinished(steps: readonly OnboardingStepStatus[]): OnboardingStep | undefined {
  return steps.find((status) => status.state === "INCOMPLETE")?.step;
}

/**
 * What stands between this profile and going live.
 *
 * A connected channel, not merely a configured one: activation is the moment the business starts answering
 * customers, and an account waiting for re-authorization answers nobody. Style is absent by design — the
 * checklist in ONBOARDING_UX.md asks for it "configured or intentionally skipped", which is a step
 * question rather than a launch blocker.
 */
/**
 * Why activation is not available, given the facts *and* what a person deliberately set aside.
 *
 * The skip set is a parameter rather than something read from the facts, because a skip is a decision and
 * not a state of the product: "nobody has written a voice yet" and "somebody decided this business does
 * not need one" look identical in `facts` and must not get the same answer. `ONBOARDING_UX.md` says the
 * checklist enforces "style configured **or intentionally skipped**", and both halves of that are here.
 *
 * Only the validated skips arrive: the caller filters them through `isSkippableOnboardingStep`, so a
 * fabricated row naming an unskippable step cannot unlock anything.
 */
function blockersFor(facts: OnboardingFacts, deliberatelySkipped: ReadonlySet<OnboardingStep>): ActivationBlocker[] {
  const blockers: ActivationBlocker[] = [];
  if (!facts.channels.some((channel) => channel.status === "CONNECTED")) {
    blockers.push("NO_CONNECTED_CHANNEL");
  }
  if (facts.knowledgeDocumentCount === 0) {
    blockers.push("NO_KNOWLEDGE");
  }
  // A voice the assistant will speak in is part of going live, and this is the one blocker a person can
  // clear two ways. Going live with neither means every customer hears whatever the model defaults to,
  // which is the thing an owner is least able to predict and most likely to be judged on.
  if (!facts.styleConfigured && !deliberatelySkipped.has("STYLE")) {
    blockers.push("STYLE_NOT_CONFIGURED");
  }
  if (!facts.policyConfigured) {
    blockers.push("NO_POLICY");
  }
  if (facts.blockingReviewItemCount > 0) {
    blockers.push("UNRESOLVED_REVIEW_ITEMS");
  }
  return blockers;
}
