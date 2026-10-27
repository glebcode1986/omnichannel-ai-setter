/**
 * Judging a release from evidence (#60, LAUNCH_READINESS.md).
 *
 * Two of these tests are the ones that matter, and both are about a mistake this repository has actually
 * made rather than one it might:
 *
 * - a verdict left on an older commit must not read as the current position of a newer one, in either
 *   direction;
 * - a gate nobody evaluated must not read as a gate that passed.
 *
 * What is deliberately *not* here is the catalogue's parity with `LAUNCH_READINESS.md`. This package is
 * pure — it has no Node types, by the same rule that keeps it runnable anywhere — so reading a file from
 * it is a type error. That test lives in `scripts/release/gates.test.ts`, beside the verification gate's
 * own walk of the repository, which exists for the same reason.
 */
import { describe, expect, it } from "vitest";

import {
  GATE_SEVERITIES,
  RELEASE_GATES,
  releaseApproved,
  releaseDecision,
  ROLLOUT_STAGES,
  rolloutPermitsAutopilot,
  rolloutStageAtLeast,
  reviewerStatusOf,
  worstSeverity,
  type GateResult,
  type ReleaseReview,
} from "./index";

/** A full set of passing results, which every case below then spoils in exactly one way. */
function allPassing(overrides: readonly GateResult[] = []): GateResult[] {
  const byGate = new Map(overrides.map((result) => [result.gateId, result]));
  return RELEASE_GATES.map((gate) => byGate.get(gate.id) ?? { gateId: gate.id, severity: "PASS", evidence: `run 1 covered ${gate.id}` });
}

describe("judging a release", () => {
  it("releases when every gate passed with evidence", () => {
    const decision = releaseDecision(allPassing());

    expect(decision).toMatchObject({ releasable: true, blockers: [], disabledCapabilities: [], knownLimitations: [] });
  });

  it("refuses a gate nobody evaluated, because silence is not a pass", () => {
    // The one that would otherwise be missed. A report listing nineteen passes reads as nineteen passes,
    // and the omitted twentieth is exactly where an untested path lives.
    const decision = releaseDecision(allPassing().filter((result) => result.gateId !== "TENANT_ISOLATION"));

    expect(decision.releasable).toBe(false);
    expect(decision.blockers).toEqual([{ gateId: "TENANT_ISOLATION", refusal: "GATE_NOT_EVALUATED" }]);
  });

  it("refuses a pass with nothing recorded behind it", () => {
    // The spec's words: "do not rely on 'Claude ran it locally' without recorded commands/results".
    const decision = releaseDecision(allPassing([{ gateId: "MESSAGING_E2E", severity: "PASS", evidence: "   " }]));

    expect(decision.releasable).toBe(false);
    expect(decision.blockers).toEqual([{ gateId: "MESSAGING_E2E", refusal: "EVIDENCE_MISSING" }]);
  });

  it("reports every reason rather than the first", () => {
    const decision = releaseDecision(
      allPassing([
        { gateId: "MESSAGING_E2E", severity: "BLOCKER", evidence: "duplicate send observed" },
        { gateId: "PRIVACY_DELETION", severity: "BLOCKER", evidence: "export authorization missing" },
      ]).filter((result) => result.gateId !== "LOAD_CONCURRENCY"),
    );

    // A release manager fixes the list, not the head of it.
    expect(decision.blockers).toEqual([
      { gateId: "MESSAGING_E2E", refusal: "BLOCKER_GATE" },
      { gateId: "LOAD_CONCURRENCY", refusal: "GATE_NOT_EVALUATED" },
      { gateId: "PRIVACY_DELETION", refusal: "BLOCKER_GATE" },
    ]);
  });

  it("leaves a capability switched off for a HIGH, and still releases", () => {
    // The spec's definition of HIGH: "the affected autonomous capability remains disabled until fixed".
    const decision = releaseDecision(allPassing([{ gateId: "MEDIA", severity: "HIGH", evidence: "transcription retries are untested" }]));

    expect(decision.releasable).toBe(true);
    expect(decision.disabledCapabilities).toEqual(["VOICE_TRANSCRIPTION"]);
  });

  it("escalates a HIGH that has nothing to disable", () => {
    // A HIGH on a gate guarding the release itself has no capability to switch off, so treating it as a
    // warning would be treating it as nothing at all. The refusal says which kind of wrong it is, so the
    // reader can fix the gate or fix the model.
    const decision = releaseDecision(allPassing([{ gateId: "TENANT_ISOLATION", severity: "HIGH", evidence: "one filter untested" }]));

    expect(decision.releasable).toBe(false);
    expect(decision.blockers).toEqual([{ gateId: "TENANT_ISOLATION", refusal: "HIGH_WITH_NOTHING_TO_DISABLE" }]);
  });

  it("ships a limitation only when something bounds it", () => {
    const bounded = releaseDecision(
      allPassing([{ gateId: "BOOKING", severity: "KNOWN_LIMITATION", evidence: "capability disabled", note: "Booking is not enabled for this release" }]),
    );
    const unbounded = releaseDecision(allPassing([{ gateId: "BOOKING", severity: "KNOWN_LIMITATION", evidence: "capability disabled" }]));

    expect(bounded).toMatchObject({ releasable: true, knownLimitations: [{ gateId: "BOOKING", note: "Booking is not enabled for this release" }] });
    expect(unbounded.releasable).toBe(false);
    expect(unbounded.blockers).toEqual([{ gateId: "BOOKING", refusal: "LIMITATION_UNDOCUMENTED" }]);
  });

  it("reports disabled capabilities in a stable order", () => {
    const decision = releaseDecision(
      allPassing([
        { gateId: "BOOKING", severity: "HIGH", evidence: "untested" },
        { gateId: "AUTOPILOT_HEADLESS", severity: "HIGH", evidence: "untested" },
        { gateId: "MEDIA", severity: "HIGH", evidence: "untested" },
      ]),
    );

    // Two runs over the same results have to read identically, or a diff of two reports is noise.
    expect(decision.disabledCapabilities).toEqual(["AUTOPILOT", "VOICE_TRANSCRIPTION", "BOOKING"]);
  });

  it("names the worst thing in a set", () => {
    expect(worstSeverity([])).toBe("PASS");
    expect(worstSeverity([{ gateId: "MEDIA", severity: "KNOWN_LIMITATION", evidence: "x" }])).toBe("KNOWN_LIMITATION");
    expect(
      worstSeverity([
        { gateId: "MEDIA", severity: "BLOCKER", evidence: "x" },
        { gateId: "BOOKING", severity: "HIGH", evidence: "x" },
      ]),
    ).toBe("BLOCKER");
    expect(GATE_SEVERITIES.at(-1)).toBe("BLOCKER");
  });
});

describe("results that are not one verdict per gate", () => {
  it("refuses two verdicts for one gate instead of taking the last one", () => {
    // The merge that looks clean: two runs' result lists concatenated. Last-wins would have discarded one
    // of them, and the one discarded is as likely to be the BLOCKER as the PASS — here it is the BLOCKER.
    const decision = releaseDecision([
      ...allPassing().filter((result) => result.gateId !== "MEDIA"),
      { gateId: "MEDIA", severity: "BLOCKER", evidence: "duplicate send under retry" },
      { gateId: "MEDIA", severity: "PASS", evidence: "second run was clean" },
    ]);

    expect(decision.releasable).toBe(false);
    expect(decision.blockers).toContainEqual({ gateId: "MEDIA", refusal: "DUPLICATE_GATE_RESULT" });
  });

  it("reports a result for a gate it does not define rather than ignoring the row", () => {
    // What this protects is archived records. Ignoring an unknown id would mean that removing a gate from
    // the catalogue silently drops a stored BLOCKER carrying it — and `releaseDecision` is recomputed on
    // every send, so that record's `approved` would flip from false to true with nothing written.
    const decision = releaseDecision([...allPassing(), { gateId: "MEDIA_PIPELINE", severity: "BLOCKER", evidence: "renamed gate" }]);

    expect(decision.releasable).toBe(false);
    expect(decision.blockers).toEqual([{ gateId: "MEDIA_PIPELINE", refusal: "UNKNOWN_GATE" }]);
  });
});

describe("a reviewer's verdict belongs to a commit", () => {
  const review = (overrides: Partial<ReleaseReview> = {}): ReleaseReview => ({
    reviewer: "astra",
    verdict: "PASS",
    reviewedSha: "aaaa111",
    submittedAt: new Date("2026-10-08T10:00:00.000Z"),
    ...overrides,
  });

  it("ignores a PASS given to another commit", () => {
    // The spec: "never transfer a PASS from an older SHA to a newer one".
    expect(reviewerStatusOf("bbbb222", [review()])).toBe("NOT_REVIEWED");
    expect(reviewerStatusOf("aaaa111", [review()])).toBe("PASS");
  });

  it("ignores a CHANGES_REQUESTED left on a commit that was repaired", () => {
    // The inverse, and it has happened here: a stale `CHANGES_REQUESTED` sat on one SHA while the branch
    // head was two commits further on, and read as the current verdict to anybody glancing at it.
    const stale = review({ verdict: "CHANGES_REQUESTED", reviewedSha: "old0000", submittedAt: new Date("2026-10-05T13:02:00.000Z") });

    expect(reviewerStatusOf("new1111", [stale])).toBe("NOT_REVIEWED");
  });

  it("takes the newest verdict on the commit, because a reviewer who looked twice meant the second time", () => {
    const first = review({ verdict: "CHANGES_REQUESTED", submittedAt: new Date("2026-10-05T13:02:00.000Z") });
    const second = review({ verdict: "PASS", submittedAt: new Date("2026-10-08T10:00:00.000Z") });

    expect(reviewerStatusOf("aaaa111", [first, second])).toBe("PASS");
    expect(reviewerStatusOf("aaaa111", [second, first])).toBe("PASS");
    // And the other way round, so the ordering is really being read.
    expect(reviewerStatusOf("aaaa111", [second, review({ verdict: "CHANGES_REQUESTED", submittedAt: new Date("2026-10-09T10:00:00.000Z") })])).toBe(
      "CHANGES_REQUESTED",
    );
  });

  it("says nobody has looked rather than guessing", () => {
    expect(reviewerStatusOf("aaaa111", [])).toBe("NOT_REVIEWED");
  });
});

describe("two verdicts in the same instant", () => {
  it("takes the refusal, so the answer is neither arbitrary nor the permissive one", () => {
    // Equal timestamps are not exotic: a script filing a batch of verdicts parsed from one report stamps
    // them all with the batch's own time. Sorting alone leaves the winner to insertion order — and this
    // is recomputed on every send, so the same stored rows could answer differently on two deployments.
    const at = new Date("2026-10-01T12:00:00.000Z");
    const sha = "a".repeat(40);
    const reviews: ReleaseReview[] = [
      { reviewer: "astra", verdict: "PASS", reviewedSha: sha, submittedAt: at },
      { reviewer: "codex", verdict: "CHANGES_REQUESTED", reviewedSha: sha, submittedAt: at },
    ];

    expect(reviewerStatusOf(sha, reviews)).toBe("CHANGES_REQUESTED");
    // And the order they arrive in does not change it, which is the half that would otherwise pass by
    // accident on whichever order the database happened to return.
    expect(reviewerStatusOf(sha, [...reviews].toReversed())).toBe("CHANGES_REQUESTED");
  });

  it("still lets a later second withdraw it, so the tie-break is not a trap", () => {
    const sha = "a".repeat(40);

    expect(
      reviewerStatusOf(sha, [
        { reviewer: "astra", verdict: "PASS", reviewedSha: sha, submittedAt: new Date("2026-10-01T12:00:00.000Z") },
        { reviewer: "codex", verdict: "CHANGES_REQUESTED", reviewedSha: sha, submittedAt: new Date("2026-10-01T12:00:00.000Z") },
        { reviewer: "codex", verdict: "PASS", reviewedSha: sha, submittedAt: new Date("2026-10-01T12:00:01.000Z") },
      ]),
    ).toBe("PASS");
  });
});

describe("approving a release", () => {
  it("needs the gates and the reviewer, and can say which is missing", () => {
    const sha = "aaaa111";
    const reviewed: ReleaseReview[] = [{ reviewer: "astra", verdict: "PASS", reviewedSha: sha, submittedAt: new Date("2026-10-08T10:00:00.000Z") }];

    // Verifies and nobody has looked: the most common state a candidate is in, and the one most worth
    // being able to name.
    expect(releaseApproved({ sha, results: allPassing(), reviews: [] })).toMatchObject({ approved: false, reviewer: "NOT_REVIEWED" });
    // Reviewed and does not verify.
    const broken = releaseApproved({ sha, results: allPassing([{ gateId: "MEDIA", severity: "BLOCKER", evidence: "x" }]), reviews: reviewed });
    expect(broken.approved).toBe(false);
    expect(broken.reviewer).toBe("PASS");
    expect(broken.decision.blockers).toEqual([{ gateId: "MEDIA", refusal: "BLOCKER_GATE" }]);
    // Both.
    expect(releaseApproved({ sha, results: allPassing(), reviews: reviewed }).approved).toBe(true);
  });
});

describe("the staged rollout", () => {
  it("is a progression, compared by position", () => {
    expect(rolloutStageAtLeast("COMMERCIAL_BETA", "LIMITED_AUTOPILOT")).toBe(true);
    expect(rolloutStageAtLeast("INTERNAL", "DESIGN_PARTNERS_DRAFT")).toBe(false);
    expect(rolloutStageAtLeast("GENERAL_AVAILABILITY", "GENERAL_AVAILABILITY")).toBe(true);
    expect(ROLLOUT_STAGES).toEqual(["INTERNAL", "DESIGN_PARTNERS_DRAFT", "LIMITED_AUTOPILOT", "COMMERCIAL_BETA", "GENERAL_AVAILABILITY"]);
  });

  it("refuses unattended sending before the limited-autopilot stage, for everybody", () => {
    // §18's "DRAFT-first": during the early stages nobody autopilots, whatever an allowlist says.
    for (const stage of ["INTERNAL", "DESIGN_PARTNERS_DRAFT"] as const) {
      expect(rolloutPermitsAutopilot({ stage, explicitlyEnabled: true, disabledCapabilities: [] }), stage).toBe(false);
      expect(rolloutPermitsAutopilot({ stage, explicitlyEnabled: false, disabledCapabilities: [] }), stage).toBe(false);
    }
  });

  it("permits it at the limited stage only for an explicitly enabled profile", () => {
    expect(rolloutPermitsAutopilot({ stage: "LIMITED_AUTOPILOT", explicitlyEnabled: true, disabledCapabilities: [] })).toBe(true);
    expect(rolloutPermitsAutopilot({ stage: "LIMITED_AUTOPILOT", explicitlyEnabled: false, disabledCapabilities: [] })).toBe(false);
  });

  it("stops consulting the allowlist once the beta opens", () => {
    // A rollout that kept an allowlist for ever would be a permanent gate wearing a temporary name.
    for (const stage of ["COMMERCIAL_BETA", "GENERAL_AVAILABILITY"] as const) {
      expect(rolloutPermitsAutopilot({ stage, explicitlyEnabled: false, disabledCapabilities: [] }), stage).toBe(true);
    }
  });

  it("does not apply at all when no release is in force", () => {
    // Not the same as an early stage, and deliberately so: a development checkout, a test database and a
    // deployment that has never recorded a release are all in this state, and switching automated sending
    // off for all of them would say the gate is in the wrong place rather than that the default is right.
    expect(rolloutPermitsAutopilot({ explicitlyEnabled: false, disabledCapabilities: [] })).toBe(true);
  });

  it("answers every stage and allowlist combination exactly as §18 reads", () => {
    // The whole table rather than a property, because the property this used to assert — "it only ever
    // subtracts" — is not expressible here: this function cannot see what the plan permitted, so
    // monotonicity is a property of `evaluatePolicy` and is tested there. What it asserted instead was
    // that the outcomes are booleans and that at least one of them is false, which the return type and
    // one stage already guarantee: it would have passed with `INTERNAL` permitting unattended sending.
    //
    // Spelled out, a stage that quietly changes meaning is a failing test.
    const table = ROLLOUT_STAGES.map((stage) => [
      stage,
      rolloutPermitsAutopilot({ stage, explicitlyEnabled: false, disabledCapabilities: [] }),
      rolloutPermitsAutopilot({ stage, explicitlyEnabled: true, disabledCapabilities: [] }),
    ]);

    expect(table).toEqual([
      ["INTERNAL", false, false],
      ["DESIGN_PARTNERS_DRAFT", false, false],
      ["LIMITED_AUTOPILOT", false, true],
      ["COMMERCIAL_BETA", true, true],
      ["GENERAL_AVAILABILITY", true, true],
    ]);
  });

  it("refuses unattended sending when the release's own gates switched AUTOPILOT off", () => {
    // The spec's `HIGH` is "the affected autonomous capability remains disabled", and `HIGH` is
    // deliberately not a blocker — so the release goes out and something has to keep the capability off.
    // This is that something, and it overrules every stage including the two that permit everybody.
    for (const stage of ROLLOUT_STAGES) {
      expect(rolloutPermitsAutopilot({ stage, explicitlyEnabled: true, disabledCapabilities: ["AUTOPILOT"] }), stage).toBe(false);
    }
    // And only that capability: a HIGH on transcription does not stop replies going out.
    expect(
      rolloutPermitsAutopilot({ stage: "GENERAL_AVAILABILITY", explicitlyEnabled: false, disabledCapabilities: ["VOICE_TRANSCRIPTION"] }),
    ).toBe(true);
  });
});
