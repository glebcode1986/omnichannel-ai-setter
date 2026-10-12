/**
 * The seal that proves the server refused this exact proposal (Issue #30, R5 re-review finding 1).
 *
 * The finding was that comparing the posted impact codes against the freshly computed ones is not proof
 * of anything: the codes are public, so a first crafted POST can name them without a summary ever having
 * been rendered. These cases pin the properties that make the seal proof instead — it cannot be produced
 * without the secret, and it does not survive a change to any of the three things it covers.
 */
import { describe, expect, it } from "vitest";

import { proposalSealed, sealProposal } from "./proposal-seal";
import type { PolicyProposal } from "./settings-view";

const SECRET = "a-test-secret-at-least-32-characters-long";

const PROPOSAL: PolicyProposal = {
  mode: "AUTOPILOT",
  businessGoal: "Book consultations",
  qualificationCriteria: ["has a budget"],
  timingPreset: "NATURAL",
  takeoverPauseHours: 6,
  instagramAfterWindowPolicy: "STANDARD_ONLY",
  whatsappAfterWindowPolicy: "SERVICE_WINDOW_ONLY",
  whatsappTemplateAutomationAllowlist: [],
  expectedVersion: 4,
};

const IMPACTS = ["AUTOPILOT_ENABLED", "CONFIDENCE_LOWERED"] as const;

describe("a seal the server minted", () => {
  it("verifies for the proposal, version and impacts it was minted over", () => {
    expect(proposalSealed(SECRET, PROPOSAL, IMPACTS, sealProposal(SECRET, PROPOSAL, IMPACTS))).toBe(true);
  });

  it("does not depend on the order the impacts were listed in", () => {
    // The impacts are a set to the comparison that uses them. A seal that depended on the server's
    // enumeration order would stop verifying the day that order changed, for no reason a reader could see.
    const seal = sealProposal(SECRET, PROPOSAL, ["CONFIDENCE_LOWERED", "AUTOPILOT_ENABLED"]);

    expect(proposalSealed(SECRET, PROPOSAL, IMPACTS, seal)).toBe(true);
  });
});

describe("a seal that does not match what it is being used for", () => {
  const seal = sealProposal(SECRET, PROPOSAL, IMPACTS);

  it("fails for a different proposal", () => {
    expect(proposalSealed(SECRET, { ...PROPOSAL, businessGoal: "Something else" }, IMPACTS, seal)).toBe(false);
    expect(proposalSealed(SECRET, { ...PROPOSAL, mode: "DRAFT" }, IMPACTS, seal)).toBe(false);
  });

  it("fails for a different version of the same values", () => {
    // The policy moved underneath the acknowledgement, so the change being confirmed is not the change
    // that was shown.
    expect(proposalSealed(SECRET, { ...PROPOSAL, expectedVersion: 5 }, IMPACTS, seal)).toBe(false);
  });

  it("fails for a different impact list", () => {
    expect(proposalSealed(SECRET, PROPOSAL, ["AUTOPILOT_ENABLED"], seal)).toBe(false);
    expect(proposalSealed(SECRET, PROPOSAL, [...IMPACTS, "REVIEW_TOPICS_REMOVED"], seal)).toBe(false);
  });

  it("fails under a different secret", () => {
    expect(proposalSealed("another-secret-at-least-32-characters-long", PROPOSAL, IMPACTS, seal)).toBe(false);
  });
});

describe("a seal that is not one at all", () => {
  it("is refused rather than throwing", () => {
    // These arrive from a URL, so every one of them is reachable from a hand-edited link. A throw here
    // would be an error page where a refusal belongs.
    for (const candidate of ["", "not base64url!!", "AAAA", "x".repeat(200), Buffer.from("short", "utf8").toString("base64url")]) {
      expect(proposalSealed(SECRET, PROPOSAL, IMPACTS, candidate), candidate.slice(0, 20)).toBe(false);
    }
  });

  it("is URL-safe when minted, so the link that carries it survives being a link", () => {
    const seal = sealProposal(SECRET, PROPOSAL, IMPACTS);

    expect(seal).toBe(encodeURIComponent(seal));
  });
});
