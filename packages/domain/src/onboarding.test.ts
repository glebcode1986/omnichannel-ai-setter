/**
 * Onboarding readiness (Issue #27).
 *
 * The cases worth writing are the ones where a nearly-ready workspace must still be told "not yet", and
 * the ones where a person's own decision to skip something must be honoured rather than argued with.
 */
import { describe, expect, it } from "vitest";

import {
  channelReadiness,
  evaluateOnboarding,
  ONBOARDING_STEPS,
  SKIPPABLE_ONBOARDING_STEPS,
  type ChannelOnboardingFacts,
  type OnboardingFacts,
  type OnboardingStep,
} from "./onboarding";

const connectedChannel = (overrides: Partial<ChannelOnboardingFacts> = {}): ChannelOnboardingFacts => ({
  channel: "INSTAGRAM",
  status: "CONNECTED",
  canCarryText: true,
  mode: "DRAFT",
  outboundSuspended: false,
  caveats: [],
  ...overrides,
});

/** A profile that has done everything and is one click from going live. */
const ready = (overrides: Partial<OnboardingFacts> = {}): OnboardingFacts => ({
  channels: [connectedChannel()],
  policyConfigured: true,
  timingConfigured: true,
  channelPolicyConfigured: true,
  knowledgeDocumentCount: 3,
  styleConfigured: true,
  testDriveCompleted: true,
  blockingReviewItemCount: 0,
  activated: false,
  ...overrides,
});

const stateOf = (facts: OnboardingFacts, step: OnboardingStep) =>
  evaluateOnboarding(facts).steps.find((status) => status.step === step)?.state;

describe("the channel readiness ladder", () => {
  it("separates the four states the product must not conflate", () => {
    // Each rung answers one more question than the one above it, which is the whole point: "connected"
    // and "would send right now" are different sentences to the person reading the card.
    expect(channelReadiness(connectedChannel({ status: "NEEDS_REAUTH" }))).toBe("CONFIGURED");
    expect(channelReadiness(connectedChannel({ mode: "OFF" }))).toBe("CONNECTED");
    expect(channelReadiness(connectedChannel({ outboundSuspended: true }))).toBe("ELIGIBLE");
    expect(channelReadiness(connectedChannel())).toBe("SENDABLE");
  });

  it("does not call a channel sendable when it cannot carry a reply", () => {
    // A channel with no text capability supports everything except the thing an AI setter does.
    expect(channelReadiness(connectedChannel({ canCarryText: false }))).toBe("CONNECTED");
  });

  it("reports a disconnected account as configured rather than absent", () => {
    // The person did connect it once. Calling it "not configured" would send them back to step one
    // instead of telling them to re-authorize, which is the actionable difference ONBOARDING_UX.md asks for.
    expect(channelReadiness(connectedChannel({ status: "DISCONNECTED" }))).toBe("CONFIGURED");
  });
});

describe("resuming onboarding", () => {
  it("has nothing left to do once everything is done", () => {
    const state = evaluateOnboarding(ready({ activated: true }));

    expect(state.nextStep).toBeUndefined();
    expect(state.steps.every((status) => status.state === "COMPLETE")).toBe(true);
  });

  it("resumes at the first unfinished step, not the first one after the last finished one", () => {
    // Knowledge done, style not, timing done. The answer is STYLE: onboarding is a checklist a person can
    // fill in any order, and a pointer that only moved forward would skip what they left behind.
    const state = evaluateOnboarding(ready({ styleConfigured: false }));

    expect(state.nextStep).toBe("STYLE");
  });

  it("moves past a step the person deliberately skipped", () => {
    const facts = ready({ styleConfigured: false, testDriveCompleted: false });

    expect(evaluateOnboarding(facts).nextStep).toBe("STYLE");
    expect(evaluateOnboarding(facts, ["STYLE"]).nextStep).toBe("TEST_DRIVE");
    // Skipping the last two optional steps does not end the journey — activation is still ahead, and
    // saying "nothing left to do" to a profile that has not gone live would be the wrong sentence.
    expect(evaluateOnboarding(facts, ["STYLE", "TEST_DRIVE"]).nextStep).toBe("ACTIVATION");
  });

  it("marks a skipped step as skipped rather than complete", () => {
    // They are different answers to "did you set up a voice for this business", and the checklist has to
    // keep saying which one happened.
    const facts = ready({ styleConfigured: false });

    expect(stateOf(facts, "STYLE")).toBe("INCOMPLETE");
    expect(evaluateOnboarding(facts, ["STYLE"]).steps.find((s) => s.step === "STYLE")?.state).toBe("SKIPPED");
  });

  it("ignores a skip recorded for a step that may not be skipped", () => {
    // A stored skip for knowledge is a bug or a tampered row. Honouring it would let a setter answer
    // customers with no facts at all, so the safe reading is that the step is simply not done.
    const facts = ready({ knowledgeDocumentCount: 0 });

    expect(evaluateOnboarding(facts, ["KNOWLEDGE"]).nextStep).toBe("KNOWLEDGE");
    expect(evaluateOnboarding(facts, ["KNOWLEDGE"]).activationBlockers).toContain("NO_KNOWLEDGE");
  });

  it("keeps the step list in the order the spec prescribes", () => {
    expect(evaluateOnboarding(ready()).steps.map((status) => status.step)).toEqual([...ONBOARDING_STEPS]);
  });

  it("offers a skip only where a skip is legitimate", () => {
    const skippable = evaluateOnboarding(ready()).steps.filter((status) => status.skippable).map((status) => status.step);

    expect(skippable).toEqual([...SKIPPABLE_ONBOARDING_STEPS]);
  });
});

describe("the activation checklist", () => {
  it("lets a ready profile go live", () => {
    const state = evaluateOnboarding(ready());

    expect(state.activationBlockers).toEqual([]);
    expect(state.canActivate).toBe(true);
  });

  it("refuses a channel that is configured but not connected", () => {
    // Activation is the moment the business starts answering customers, and an account waiting for
    // re-authorization answers nobody. Having *done* the channel step is not the same as being reachable.
    const state = evaluateOnboarding(ready({ channels: [connectedChannel({ status: "NEEDS_REAUTH" })] }));

    expect(stateOf(ready({ channels: [connectedChannel({ status: "NEEDS_REAUTH" })] }), "CHANNELS")).toBe("COMPLETE");
    expect(state.activationBlockers).toContain("NO_CONNECTED_CHANNEL");
    expect(state.canActivate).toBe(false);
  });

  it("lets a business launch on one channel", () => {
    // ONBOARDING_UX.md is explicit: a customer may launch with one channel and add the other later.
    const state = evaluateOnboarding(ready({ channels: [connectedChannel({ channel: "INSTAGRAM" })] }));

    expect(state.canActivate).toBe(true);
  });

  it("refuses to launch on top of review items nobody has dealt with", () => {
    const state = evaluateOnboarding(ready({ blockingReviewItemCount: 2 }));

    expect(state.activationBlockers).toContain("UNRESOLVED_REVIEW_ITEMS");
    expect(state.canActivate).toBe(false);
  });

  it("blocks a launch on a style nobody wrote and nobody skipped", () => {
    // `ONBOARDING_UX.md`: the checklist enforces "style configured **or intentionally skipped**". Two
    // ways to clear it, and neither is "leave it and launch anyway" — a profile that goes live with no
    // voice answers every customer in whatever the model defaults to, which is the thing an owner is
    // least able to predict and most likely to be judged on.
    const state = evaluateOnboarding(ready({ styleConfigured: false }));

    expect(state.activationBlockers).toEqual(["STYLE_NOT_CONFIGURED"]);
    expect(state.canActivate).toBe(false);
  });

  it("allows a launch once a voice is configured", () => {
    const state = evaluateOnboarding(ready({ styleConfigured: true }));

    expect(state.activationBlockers).toEqual([]);
    expect(state.canActivate).toBe(true);
  });

  it("allows a launch when a person deliberately skipped the style step", () => {
    // The second way to clear it. A skip is a decision somebody made and the product recorded, which is
    // a different fact from the step simply being unfinished.
    const state = evaluateOnboarding(ready({ styleConfigured: false }), ["STYLE"]);

    expect(state.activationBlockers).toEqual([]);
    expect(state.canActivate).toBe(true);
    expect(state.steps.find((status) => status.step === "STYLE")?.state).toBe("SKIPPED");
  });

  it("does not let a skip of some other step unlock the style gate", () => {
    // Otherwise skipping the test drive would quietly launch a profile with no voice.
    const state = evaluateOnboarding(ready({ styleConfigured: false }), ["TEST_DRIVE", "TIMING_AND_HANDOFF"]);

    expect(state.activationBlockers).toEqual(["STYLE_NOT_CONFIGURED"]);
    expect(state.canActivate).toBe(false);
  });

  it("ignores a skip naming a step that may not be skipped", () => {
    // `onboarding_skips` rows are validated on write, but the gate must not depend on that being the only
    // way a row can appear. A fabricated skip of an unskippable step unlocks nothing.
    const state = evaluateOnboarding(ready({ knowledgeDocumentCount: 0 }), ["KNOWLEDGE"]);

    expect(state.activationBlockers).toContain("NO_KNOWLEDGE");
    expect(state.canActivate).toBe(false);
  });

  it("does not offer to activate a profile that is already live", () => {
    const state = evaluateOnboarding(ready({ activated: true }));

    expect(state.activationBlockers).toEqual([]);
    expect(state.canActivate).toBe(false);
  });

  it("lists every blocker at once rather than one at a time", () => {
    // A checklist that revealed problems one reload at a time would be a worse experience than a list.
    const state = evaluateOnboarding({
      channels: [],
      policyConfigured: false,
      timingConfigured: false,
      channelPolicyConfigured: false,
      knowledgeDocumentCount: 0,
      styleConfigured: false,
      testDriveCompleted: false,
      blockingReviewItemCount: 1,
      activated: false,
    });

    // In the order `ONBOARDING_UX.md` lists them, which is the order a person should deal with them.
    expect(state.activationBlockers).toEqual([
      "NO_CONNECTED_CHANNEL",
      "NO_KNOWLEDGE",
      "STYLE_NOT_CONFIGURED",
      "NO_POLICY",
      "UNRESOLVED_REVIEW_ITEMS",
    ]);
  });
});
