/**
 * The two numbers a billing screen puts in front of a decision (#42).
 *
 * Both are arithmetic, and both are the kind that is wrong in one direction only when it matters: an
 * allowance that reads healthy at its last second, and a downgrade that says "you are over" without
 * saying over what.
 */
import { describe, expect, it } from "vitest";

import { DomainValidationError } from "./errors";
import { allowanceState, DEFAULT_ALLOWANCE_WARNING_FRACTION, planChangeConsequences, PLAN_FEATURES, type PlanFeature } from "./index";

const everything = Object.fromEntries(PLAN_FEATURES.map((feature) => [feature, true])) as Record<PlanFeature, boolean>;
const nothing = Object.fromEntries(PLAN_FEATURES.map((feature) => [feature, false])) as Record<PlanFeature, boolean>;

describe("the state of one allowance", () => {
  it("counts what was bought as part of what is available", () => {
    const state = allowanceState({ included: 100, purchased: 500, used: 120 });

    expect(state).toMatchObject({ included: 100, purchased: 500, used: 120, remaining: 480, health: "OK" });
  });

  it("warns while there is still something left", () => {
    // The point of a warning: it has to arrive before exhaustion, not with it.
    expect(allowanceState({ included: 100, used: 91 }).health).toBe("WARNING");
    expect(allowanceState({ included: 100, used: 89 }).health).toBe("OK");
    expect(allowanceState({ included: 100, used: 90 }).health).toBe("WARNING");
  });

  it("uses the stated default share, so the badge and the sentence cannot disagree", () => {
    const included = 1_000;
    const atThreshold = included - included * DEFAULT_ALLOWANCE_WARNING_FRACTION;

    expect(allowanceState({ included, used: atThreshold }).health).toBe("WARNING");
  });

  it("honours a caller's own threshold", () => {
    expect(allowanceState({ included: 100, used: 50, warnAtFraction: 0.6 }).health).toBe("WARNING");
    expect(allowanceState({ included: 100, used: 50, warnAtFraction: 0.2 }).health).toBe("OK");
  });

  it("is exhausted at nothing left, and stays exhausted past it", () => {
    expect(allowanceState({ included: 100, used: 100 }).health).toBe("EXHAUSTED");
    // A commit may legitimately exceed what was held — the work happened. "Minus forty remaining" is not
    // something anybody can read, and the fact it conveys is already exhaustion.
    expect(allowanceState({ included: 100, used: 140 })).toMatchObject({ remaining: 0, health: "EXHAUSTED" });
  });

  it("calls an allowance of nothing exhausted rather than healthy", () => {
    // A plan that includes none of a resource has none left, and a share of zero is not a warning level.
    expect(allowanceState({ included: 0, used: 0 }).health).toBe("EXHAUSTED");
  });

  it("refuses a threshold that is not a share", () => {
    expect(() => allowanceState({ included: 10, used: 0, warnAtFraction: 1.5 })).toThrow(DomainValidationError);
    expect(() => allowanceState({ included: 10, used: 0, warnAtFraction: -0.1 })).toThrow(DomainValidationError);
  });
});

describe("what a plan change would cost", () => {
  const starter = { limits: { BUSINESS_PROFILES: 1, SEATS: 1 }, features: ["AI_DRAFTS" as const] };

  it("names each ceiling that would be exceeded, with the numbers", () => {
    const consequences = planChangeConsequences({
      target: starter,
      inUse: { BUSINESS_PROFILES: 3, SEATS: 4 },
      featuresInUse: nothing,
    });

    // "You are over" is not something a person can act on; "these three profiles are over a limit of one"
    // is. The accepted behaviour is that they choose which stay active, so they are owed the numbers.
    expect(consequences.overCapacity).toEqual([
      { limit: "BUSINESS_PROFILES", inUse: 3, ceiling: 1 },
      { limit: "SEATS", inUse: 4, ceiling: 1 },
    ]);
    expect(consequences.clean).toBe(false);
  });

  it("says nothing about a ceiling the workspace is exactly at", () => {
    // At the limit is within the limit. Reporting it would tell somebody a downgrade costs them something
    // when it costs them nothing.
    expect(
      planChangeConsequences({ target: starter, inUse: { BUSINESS_PROFILES: 1, SEATS: 1 }, featuresInUse: nothing }).overCapacity,
    ).toEqual([]);
  });

  it("treats an absent ceiling as uncapped, so it can never be exceeded", () => {
    const uncapped = { limits: {}, features: [...PLAN_FEATURES] };

    expect(planChangeConsequences({ target: uncapped, inUse: { SEATS: 400 }, featuresInUse: everything })).toMatchObject({ clean: true });
  });

  it("lists only the features the workspace is actually using", () => {
    const consequences = planChangeConsequences({ target: starter, inUse: {}, featuresInUse: everything });

    expect(consequences.losingFeatures).toContain("AUTOPILOT");
    expect(consequences.losingFeatures).toContain("WHATSAPP");
    // The one the target plan keeps is not a loss.
    expect(consequences.losingFeatures).not.toContain("AI_DRAFTS");
  });

  it("warns about nothing when the dropped feature was never switched on", () => {
    // A plan that drops something the business never used has cost it nothing, and saying otherwise would
    // talk somebody out of a downgrade that was free.
    expect(planChangeConsequences({ target: starter, inUse: {}, featuresInUse: { ...nothing, AI_DRAFTS: true } })).toMatchObject({
      losingFeatures: [],
      clean: true,
    });
  });

  it("reports both kinds of loss at once rather than the first it found", () => {
    const consequences = planChangeConsequences({
      target: starter,
      inUse: { BUSINESS_PROFILES: 5 },
      featuresInUse: everything,
    });

    expect(consequences.overCapacity).toHaveLength(1);
    expect(consequences.losingFeatures.length).toBeGreaterThan(0);
    expect(consequences.clean).toBe(false);
  });
});
