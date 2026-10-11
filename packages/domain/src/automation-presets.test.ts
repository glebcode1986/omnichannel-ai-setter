/**
 * Presets, and what they are not allowed to do (Issue #30).
 *
 * The important case is the floor. `MANDATORY_REVIEW_REASON_CODES` are topics that always wait for a
 * person — a payment dispute is not something an "Aggressive" setting gets to answer unattended — so the
 * test that matters is that the most permissive preset still carries every one of them.
 */
import { describe, expect, it } from "vitest";

import {
  CONFIDENCE_PRESETS,
  confidencePresetOf,
  confidenceSettingsFor,
  isConfidencePreset,
  isTimingPreset,
  policyImpactsOf,
  TIMING_PRESETS,
  timingPresetOf,
  timingSettingsFor,
} from "./automation-presets";
import { MANDATORY_REVIEW_REASON_CODES } from "./reason-codes";

describe("confidence presets", () => {
  it.each(CONFIDENCE_PRESETS)("keeps every mandatory review topic under %s", (preset) => {
    const settings = confidenceSettingsFor(preset);

    // No preset may lower the floor. This is the whole safety claim of the preset system.
    for (const reason of MANDATORY_REVIEW_REASON_CODES) {
      expect(settings.mandatoryReviewReasons, `${preset} dropped ${reason}`).toContain(reason);
    }
  });

  it("gets steadily more permissive, and never equal", () => {
    const conservative = confidenceSettingsFor("CONSERVATIVE");
    const balanced = confidenceSettingsFor("BALANCED");
    const aggressive = confidenceSettingsFor("AGGRESSIVE");

    expect(conservative.confidenceThreshold).toBeGreaterThan(balanced.confidenceThreshold);
    expect(balanced.confidenceThreshold).toBeGreaterThan(aggressive.confidenceThreshold);
    // And each one holds at least as much back as the next.
    expect(conservative.mandatoryReviewReasons.length).toBeGreaterThan(balanced.mandatoryReviewReasons.length);
    expect(balanced.mandatoryReviewReasons.length).toBeGreaterThan(aggressive.mandatoryReviewReasons.length);
  });

  it("holds a reply back when the knowledge base could not be consulted, unless asked not to", () => {
    // Answering from nothing is how a confident wrong answer happens, so only the most permissive
    // preset allows it — and that is a choice an owner makes knowingly.
    expect(confidenceSettingsFor("CONSERVATIVE").mandatoryReviewReasons).toContain("RETRIEVAL_UNAVAILABLE");
    expect(confidenceSettingsFor("BALANCED").mandatoryReviewReasons).toContain("RETRIEVAL_UNAVAILABLE");
    expect(confidenceSettingsFor("AGGRESSIVE").mandatoryReviewReasons).not.toContain("RETRIEVAL_UNAVAILABLE");
  });

  it("produces the same value however the reasons were ordered", () => {
    // Otherwise an audit diff reports a reordering as a change, and every save looks material.
    expect(confidenceSettingsFor("BALANCED").mandatoryReviewReasons).toEqual([...confidenceSettingsFor("BALANCED").mandatoryReviewReasons].sort());
  });

  it("recognises its own output", () => {
    for (const preset of CONFIDENCE_PRESETS) {
      expect(confidencePresetOf(confidenceSettingsFor(preset))).toBe(preset);
    }
  });

  it("recognises a reordered stored value as the same preset", () => {
    const balanced = confidenceSettingsFor("BALANCED");

    expect(confidencePresetOf({ ...balanced, mandatoryReviewReasons: [...balanced.mandatoryReviewReasons].reverse() })).toBe("BALANCED");
  });

  it("calls a hand-tuned policy custom rather than naming a preset it no longer matches", () => {
    const balanced = confidenceSettingsFor("BALANCED");

    // An owner who moved a value must not be shown "Balanced" as though the preset still described them.
    expect(confidencePresetOf({ ...balanced, confidenceThreshold: 0.77 })).toBeUndefined();
    expect(confidencePresetOf({ ...balanced, mandatoryReviewReasons: [...balanced.mandatoryReviewReasons, "WINDOW_CLOSED"] })).toBeUndefined();
    expect(confidencePresetOf({ ...balanced, mandatoryReviewReasons: balanced.mandatoryReviewReasons.slice(1) })).toBeUndefined();
  });

  it("guards its own vocabulary", () => {
    expect(isConfidencePreset("BALANCED")).toBe(true);
    expect(isConfidencePreset("balanced")).toBe(false);
    expect(isConfidencePreset("RECKLESS")).toBe(false);
  });
});

describe("timing presets", () => {
  it("are ranges, never a single promised delay", () => {
    for (const preset of ["FAST", "NATURAL"] as const) {
      const timing = timingSettingsFor(preset);
      expect(timing?.debounceWindowMs.maxMs).toBeGreaterThan(timing?.debounceWindowMs.minMs ?? 0);
      expect(timing?.deliveryDelayMs.maxMs).toBeGreaterThan(timing?.deliveryDelayMs.minMs ?? 0);
    }
  });

  it("makes Fast actually faster than Natural at both ends", () => {
    const fast = timingSettingsFor("FAST");
    const natural = timingSettingsFor("NATURAL");

    expect(fast?.deliveryDelayMs.maxMs).toBeLessThan(natural?.deliveryDelayMs.minMs ?? 0);
    expect(fast?.debounceWindowMs.maxMs).toBeLessThanOrEqual(natural?.debounceWindowMs.minMs ?? 0);
  });

  it("has nothing to look up for Custom, because the owner supplied the numbers", () => {
    expect(timingSettingsFor("CUSTOM")).toBeUndefined();
  });

  it("recognises its own output and calls anything else custom", () => {
    expect(timingPresetOf(timingSettingsFor("FAST") as never)).toBe("FAST");
    expect(timingPresetOf(timingSettingsFor("NATURAL") as never)).toBe("NATURAL");
    expect(
      timingPresetOf({ debounceWindowMs: { minMs: 1_000, maxMs: 2_000 }, deliveryDelayMs: { minMs: 3_000, maxMs: 4_000 } }),
    ).toBe("CUSTOM");
  });

  it("does not call a nearly-matching policy a preset", () => {
    const natural = timingSettingsFor("NATURAL") as never as { debounceWindowMs: { minMs: number; maxMs: number }; deliveryDelayMs: { minMs: number; maxMs: number } };

    expect(timingPresetOf({ ...natural, deliveryDelayMs: { ...natural.deliveryDelayMs, maxMs: natural.deliveryDelayMs.maxMs + 1 } })).toBe("CUSTOM");
  });

  it("guards its own vocabulary", () => {
    expect(TIMING_PRESETS).toEqual(["FAST", "NATURAL", "CUSTOM"]);
    expect(isTimingPreset("CUSTOM")).toBe(true);
    expect(isTimingPreset("INSTANT")).toBe(false);
  });
});

describe("which changes an owner should see the consequences of", () => {
  const settings = (overrides: Partial<Parameters<typeof policyImpactsOf>[0]> = {}) => ({
    mode: "DRAFT",
    confidenceThreshold: 0.8,
    mandatoryReviewReasons: [...MANDATORY_REVIEW_REASON_CODES] as readonly string[],
    instagramAfterWindowPolicy: "STANDARD_ONLY",
    whatsappAfterWindowPolicy: "SERVICE_WINDOW_ONLY",
    whatsappTemplateAutomationAllowlist: [] as readonly string[],
    ...overrides,
  });

  it("says nothing about a change that widens nothing", () => {
    expect(policyImpactsOf(settings(), settings({ confidenceThreshold: 0.85 }))).toEqual([]);
  });

  it("names turning on autopilot", () => {
    expect(policyImpactsOf(settings(), settings({ mode: "AUTOPILOT" }))).toEqual(["AUTOPILOT_ENABLED"]);
  });

  it("says nothing when autopilot was already on", () => {
    expect(policyImpactsOf(settings({ mode: "AUTOPILOT" }), settings({ mode: "AUTOPILOT" }))).toEqual([]);
  });

  it("names template autopilot, and separately that it would send nothing", () => {
    // ADR-016: enabled with an empty allowlist is a setting that looks on and does nothing. Better said
    // before saving than debugged a week later.
    expect(policyImpactsOf(settings(), settings({ whatsappAfterWindowPolicy: "TEMPLATE_AUTOPILOT" }))).toEqual([
      "TEMPLATE_AUTOPILOT_ENABLED",
      "TEMPLATE_AUTOPILOT_WITHOUT_ALLOWLIST",
    ]);
    expect(
      policyImpactsOf(settings(), settings({ whatsappAfterWindowPolicy: "TEMPLATE_AUTOPILOT", whatsappTemplateAutomationAllowlist: ["booking_reminder"] })),
    ).toEqual(["TEMPLATE_AUTOPILOT_ENABLED"]);
  });

  it("names widening the allowlist while template autopilot is already on", () => {
    const live = (allowlist: readonly string[]) =>
      settings({ whatsappAfterWindowPolicy: "TEMPLATE_AUTOPILOT", whatsappTemplateAutomationAllowlist: allowlist });

    // ADR-016: an empty allowlist permits no unattended template send, so the first entry is the step from
    // dormant to live. Saved as `impacts: []`, it would be a widening nobody confirmed and an audit row
    // claiming nothing material happened.
    expect(policyImpactsOf(live([]), live(["booking_reminder"]))).toEqual(["TEMPLATE_AUTOPILOT_ALLOWLIST_WIDENED"]);
    // And every later entry is one more conversation closed after the window with nobody reading it.
    expect(policyImpactsOf(live(["booking_reminder"]), live(["booking_reminder", "payment_due"]))).toEqual([
      "TEMPLATE_AUTOPILOT_ALLOWLIST_WIDENED",
    ]);
  });

  it("says nothing about an allowlist that was narrowed, reordered or merely repeated", () => {
    const live = (allowlist: readonly string[]) =>
      settings({ whatsappAfterWindowPolicy: "TEMPLATE_AUTOPILOT", whatsappTemplateAutomationAllowlist: allowlist });
    const both = ["booking_reminder", "payment_due"];

    expect(policyImpactsOf(live(both), live(["booking_reminder"]))).toEqual([]);
    expect(policyImpactsOf(live(both), live([...both].reverse()))).toEqual([]);
    // A set, so the form sending the same name twice is not a change — the store stores a set either way.
    expect(policyImpactsOf(live(["booking_reminder"]), live(["booking_reminder", "booking_reminder"]))).toEqual([]);
    // Swapping one name for another removes authority and grants authority; it is the granting half that
    // has to be confirmed, so a length comparison would have called this harmless.
    expect(policyImpactsOf(live(["booking_reminder"]), live(["payment_due"]))).toEqual(["TEMPLATE_AUTOPILOT_ALLOWLIST_WIDENED"]);
  });

  it("warns once when template autopilot is enabled and filled in the same change", () => {
    // One decision, one warning: "approved templates will go out unattended" already says what filling the
    // list means, and a second line about the list growing would describe the same consequence twice.
    expect(
      policyImpactsOf(
        settings(),
        settings({ whatsappAfterWindowPolicy: "TEMPLATE_AUTOPILOT", whatsappTemplateAutomationAllowlist: ["booking_reminder"] }),
      ),
    ).toEqual(["TEMPLATE_AUTOPILOT_ENABLED"]);
  });

  it("says nothing about an allowlist that grows while template autopilot is being turned off", () => {
    // Authority is narrowing, not widening: nothing goes unattended after the window at all once the mode
    // is no longer TEMPLATE_AUTOPILOT, whatever the list says.
    expect(
      policyImpactsOf(
        settings({ whatsappAfterWindowPolicy: "TEMPLATE_AUTOPILOT", whatsappTemplateAutomationAllowlist: [] }),
        settings({ whatsappAfterWindowPolicy: "TEMPLATE_REVIEW", whatsappTemplateAutomationAllowlist: ["booking_reminder"] }),
      ),
    ).toEqual([]);
  });

  it("names opening Instagram's human-support path", () => {
    expect(policyImpactsOf(settings(), settings({ instagramAfterWindowPolicy: "HUMAN_ASSISTED_EXTENDED" }))).toEqual([
      "HUMAN_ASSISTED_EXTENDED_ENABLED",
    ]);
  });

  it("names lowering how certain the assistant has to be", () => {
    expect(policyImpactsOf(settings(), settings({ confidenceThreshold: 0.6 }))).toEqual(["CONFIDENCE_LOWERED"]);
  });

  it("names removing a topic from the review list, and ignores adding one", () => {
    const fewer = [...MANDATORY_REVIEW_REASON_CODES].slice(1);

    expect(policyImpactsOf(settings(), settings({ mandatoryReviewReasons: fewer }))).toEqual(["REVIEW_TOPICS_REMOVED"]);
    expect(policyImpactsOf(settings(), settings({ mandatoryReviewReasons: [...MANDATORY_REVIEW_REASON_CODES, "WINDOW_CLOSED"] }))).toEqual([]);
  });

  it("names every consequence of a change that widens several things at once", () => {
    const impacts = policyImpactsOf(
      settings(),
      settings({ mode: "AUTOPILOT", confidenceThreshold: 0.5, instagramAfterWindowPolicy: "HUMAN_ASSISTED_EXTENDED" }),
    );

    expect(impacts).toEqual(["AUTOPILOT_ENABLED", "HUMAN_ASSISTED_EXTENDED_ENABLED", "CONFIDENCE_LOWERED"]);
  });
});
