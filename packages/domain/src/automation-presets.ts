/**
 * The presets an owner chooses, and the policy values they mean (AI_CONFIGURATION_UX.md, Issue #30).
 *
 * Here, in the domain, and not in the form that renders them. The contract's invariant is that frontend
 * presets map to server-owned policy values — so a browser sends the *name* of a choice and the server
 * decides what it costs. A UI that posted a threshold would be a UI that could post any threshold, and
 * "Conservative" would stop meaning anything the next time somebody edited a component.
 *
 * The names are deliberately about outcomes rather than about model internals. `AI_CONFIGURATION_UX.md` is
 * explicit that the UI must never imply raw model confidence alone controls sending: it does not, because
 * the deterministic gates run afterwards and can refuse a reply the model was certain about.
 */
import { literalGuard } from "./enum";
import { MANDATORY_REVIEW_REASON_CODES, type ReasonCode } from "./reason-codes";
import type { DurationRangeMs } from "./values";

export const CONFIDENCE_PRESETS = ["CONSERVATIVE", "BALANCED", "AGGRESSIVE"] as const;
export type ConfidencePreset = (typeof CONFIDENCE_PRESETS)[number];
export const isConfidencePreset = literalGuard(CONFIDENCE_PRESETS);

export const TIMING_PRESETS = ["FAST", "NATURAL", "CUSTOM"] as const;
export type TimingPreset = (typeof TIMING_PRESETS)[number];
export const isTimingPreset = literalGuard(TIMING_PRESETS);

/** What a confidence preset decides: how sure the assistant must be, and what always waits for a person. */
export interface ConfidenceSettings {
  readonly confidenceThreshold: number;
  readonly mandatoryReviewReasons: readonly ReasonCode[];
}

/**
 * Topics that always wait for a person regardless of preset, plus what each preset adds.
 *
 * `MANDATORY_REVIEW_REASON_CODES` is the floor and no preset can lower it — a payment dispute is not
 * something an "Aggressive" setting gets to answer unattended. What a preset chooses is how much *more*
 * than the floor waits, and how certain the model has to be about everything else.
 */
const PRESET_ADDITIONS: Readonly<Record<ConfidencePreset, readonly ReasonCode[]>> = {
  // Anything the assistant is unsure about, and anything it could not look up, waits.
  CONSERVATIVE: ["LOW_CONFIDENCE", "RETRIEVAL_UNAVAILABLE", "UNSUPPORTED_CONTENT"],
  // Retrieval outages still wait: answering from nothing is how a confident wrong answer happens.
  BALANCED: ["RETRIEVAL_UNAVAILABLE"],
  // Only the floor. Still the floor — see above.
  AGGRESSIVE: [],
};

const PRESET_THRESHOLDS: Readonly<Record<ConfidencePreset, number>> = {
  CONSERVATIVE: 0.9,
  BALANCED: 0.8,
  AGGRESSIVE: 0.65,
};

export function confidenceSettingsFor(preset: ConfidencePreset): ConfidenceSettings {
  return {
    confidenceThreshold: PRESET_THRESHOLDS[preset],
    // The floor first, then the preset's additions. Sorted and deduplicated so two equivalent choices
    // produce the same stored value and an audit diff does not report a reordering as a change.
    mandatoryReviewReasons: [...new Set([...MANDATORY_REVIEW_REASON_CODES, ...PRESET_ADDITIONS[preset]])].sort(),
  };
}

/**
 * Which preset a stored policy corresponds to, or none.
 *
 * Needed because an owner who tuned a value by hand must not be shown "Balanced" as though the preset
 * still described their settings. `undefined` means "custom", which the UI has to be able to say.
 */
export function confidencePresetOf(settings: ConfidenceSettings): ConfidencePreset | undefined {
  return CONFIDENCE_PRESETS.find((preset) => {
    const expected = confidenceSettingsFor(preset);
    return (
      expected.confidenceThreshold === settings.confidenceThreshold &&
      expected.mandatoryReviewReasons.length === settings.mandatoryReviewReasons.length &&
      expected.mandatoryReviewReasons.every((reason, index) => reason === [...settings.mandatoryReviewReasons].sort()[index])
    );
  });
}

export interface TimingSettings {
  readonly debounceWindowMs: DurationRangeMs;
  readonly deliveryDelayMs: DurationRangeMs;
}

/**
 * Timing as ranges, never as one number.
 *
 * The spec forbids promising an exact human-like delay for every message, and a range is the honest shape
 * of what actually happens: the delivery engine picks a value inside it. A single number displayed to an
 * owner would be a promise the scheduler does not make.
 */
const PRESET_TIMINGS: Readonly<Record<Exclude<TimingPreset, "CUSTOM">, TimingSettings>> = {
  FAST: {
    debounceWindowMs: { minMs: 3_000, maxMs: 6_000 },
    deliveryDelayMs: { minMs: 5_000, maxMs: 20_000 },
  },
  NATURAL: {
    debounceWindowMs: { minMs: 7_000, maxMs: 12_000 },
    deliveryDelayMs: { minMs: 30_000, maxMs: 120_000 },
  },
};

/** `undefined` for `CUSTOM`: there is nothing to look up, because the owner supplied the numbers. */
export function timingSettingsFor(preset: TimingPreset): TimingSettings | undefined {
  return preset === "CUSTOM" ? undefined : PRESET_TIMINGS[preset];
}

export function timingPresetOf(settings: TimingSettings): TimingPreset {
  const named = (["FAST", "NATURAL"] as const).find((preset) => {
    const expected = PRESET_TIMINGS[preset];
    return (
      expected.debounceWindowMs.minMs === settings.debounceWindowMs.minMs &&
      expected.debounceWindowMs.maxMs === settings.debounceWindowMs.maxMs &&
      expected.deliveryDelayMs.minMs === settings.deliveryDelayMs.minMs &&
      expected.deliveryDelayMs.maxMs === settings.deliveryDelayMs.maxMs
    );
  });
  return named ?? "CUSTOM";
}

/**
 * Whether a change is one an owner should be shown the consequences of before it is saved.
 *
 * Not every edit: a greeting is not this. What is, is anything that widens what goes out without a person
 * looking — turning on autopilot, letting templates go unattended, adding a template to the list that may
 * go unattended, opening Instagram's human-support path, lowering how certain the assistant has to be, or
 * removing a topic from the review list. The spec names the first two; the rest are the same kind of
 * change and would be strange to confirm less carefully.
 */
export interface PolicyImpactInput {
  readonly mode: string;
  readonly confidenceThreshold: number;
  readonly mandatoryReviewReasons: readonly string[];
  readonly instagramAfterWindowPolicy: string;
  readonly whatsappAfterWindowPolicy: string;
  readonly whatsappTemplateAutomationAllowlist: readonly string[];
}

export const POLICY_IMPACTS = [
  "AUTOPILOT_ENABLED",
  "TEMPLATE_AUTOPILOT_ENABLED",
  "TEMPLATE_AUTOPILOT_WITHOUT_ALLOWLIST",
  "TEMPLATE_AUTOPILOT_ALLOWLIST_WIDENED",
  "HUMAN_ASSISTED_EXTENDED_ENABLED",
  "CONFIDENCE_LOWERED",
  "REVIEW_TOPICS_REMOVED",
] as const;
export type PolicyImpact = (typeof POLICY_IMPACTS)[number];

export function policyImpactsOf(before: PolicyImpactInput, after: PolicyImpactInput): readonly PolicyImpact[] {
  const impacts: PolicyImpact[] = [];
  if (after.mode === "AUTOPILOT" && before.mode !== "AUTOPILOT") {
    impacts.push("AUTOPILOT_ENABLED");
  }
  if (after.whatsappAfterWindowPolicy === "TEMPLATE_AUTOPILOT" && before.whatsappAfterWindowPolicy !== "TEMPLATE_AUTOPILOT") {
    impacts.push("TEMPLATE_AUTOPILOT_ENABLED");
    if (after.whatsappTemplateAutomationAllowlist.length === 0) {
      // ADR-016: template autopilot with nothing on the allowlist sends nothing, so it is a setting that
      // looks enabled and does nothing. Worth saying before it is saved rather than debugged later.
      impacts.push("TEMPLATE_AUTOPILOT_WITHOUT_ALLOWLIST");
    }
  } else if (
    before.whatsappAfterWindowPolicy === "TEMPLATE_AUTOPILOT" &&
    after.whatsappAfterWindowPolicy === "TEMPLATE_AUTOPILOT" &&
    widens(before.whatsappTemplateAutomationAllowlist, after.whatsappTemplateAutomationAllowlist)
  ) {
    // The allowlist is the whole extent of unattended template authority: ADR-016 lets nothing out
    // while it is empty, so the first entry is the step from dormant to live, and every later entry is
    // one more conversation the assistant may close after the window with nobody reading it. Which is
    // the same kind of change as switching the mode on, and is why it is confirmed the same way.
    //
    // `else if`, because enabling the mode and filling the list in one edit is one decision and gets
    // one warning: `TEMPLATE_AUTOPILOT_ENABLED` already says templates will go out unattended, and a
    // second line saying the list grew would be describing the same consequence twice.
    impacts.push("TEMPLATE_AUTOPILOT_ALLOWLIST_WIDENED");
  }
  if (after.instagramAfterWindowPolicy === "HUMAN_ASSISTED_EXTENDED" && before.instagramAfterWindowPolicy !== "HUMAN_ASSISTED_EXTENDED") {
    impacts.push("HUMAN_ASSISTED_EXTENDED_ENABLED");
  }
  if (after.confidenceThreshold < before.confidenceThreshold) {
    impacts.push("CONFIDENCE_LOWERED");
  }
  const kept = new Set(after.mandatoryReviewReasons);
  if (before.mandatoryReviewReasons.some((reason) => !kept.has(reason))) {
    impacts.push("REVIEW_TOPICS_REMOVED");
  }
  return impacts;
}

/**
 * Whether the second allowlist permits a template the first did not.
 *
 * A set question, not a list one. Removing an entry narrows authority and reordering changes nothing, so
 * neither is widening; comparing lengths would call a one-for-one swap harmless and comparing positions
 * would call a reorder a widening. Duplicates are not meaningful either — the store stores a set — so the
 * form sending the same name twice is not a change.
 */
function widens(before: readonly string[], after: readonly string[]): boolean {
  const permitted = new Set(before);
  return after.some((template) => !permitted.has(template));
}
