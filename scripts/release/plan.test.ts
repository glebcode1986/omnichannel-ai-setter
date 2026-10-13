/**
 * What the release planner cannot be made to say (#60).
 *
 * Every case here is about the same property, because it is the only one that matters in a module whose
 * job is to turn a shell exit code into a launch verdict: **a pass has to come from something that ran**.
 * The spec's sentence is "do not rely on 'Claude ran it locally' without recorded commands/results", and
 * a planner that defaulted to `PASS` would be that sentence implemented backwards — with twenty gates'
 * worth of file paths in front of it making it look thorough.
 */
import { describe, expect, it } from "vitest";

import { RELEASE_GATES, releaseDecision } from "../../packages/domain/src/release";
import { automatedCoverageFor, GATE_EVIDENCE } from "./evidence";
import { commandForSuite, planGateResults } from "./plan";

/** Every command any gate's suites are run by, all succeeding. */
const everythingPassed = [
  { command: "pnpm verify", exitCode: 0 },
  { command: "pnpm test:db", exitCode: 0 },
  { command: "pnpm test:e2e", exitCode: 0 },
];

describe("routing a suite to the command that runs it", () => {
  it("routes every suite any gate names", () => {
    // The mapping is by path prefix, which is what the root scripts select on. A suite under a prefix
    // this does not know would be silently treated as covered if it were not reported.
    const unrouted = Object.values(GATE_EVIDENCE)
      .flatMap((entry) => entry.suites ?? [])
      .filter((suite) => commandForSuite(suite) === undefined);

    expect(unrouted).toEqual([]);
  });

  it("sends the infrastructure suites to the commands that have infrastructure", () => {
    expect(commandForSuite("packages/db/src/delivery-store.integration.test.ts")).toBe("pnpm test:db");
    expect(commandForSuite("apps/web/src/i18n/translate.test.ts")).toBe("pnpm test:e2e");
    expect(commandForSuite("packages/domain/src/release.test.ts")).toBe("pnpm verify");
    expect(commandForSuite("docs/specs/LAUNCH_READINESS.md")).toBeUndefined();
  });
});

describe("a planner that has run nothing", () => {
  it("passes no gate at all", () => {
    const plan = planGateResults({ commands: [] });

    expect(plan.results.filter((result) => result.severity === "PASS")).toEqual([]);
  });

  it("omits every gate that has suites, so the decision refuses the release", () => {
    const plan = planGateResults({ commands: [] });
    const withSuites = RELEASE_GATES.filter((gate) => automatedCoverageFor(gate.id)).map((gate) => gate.id);

    expect(plan.omitted.toSorted()).toEqual(withSuites.toSorted());
    const decision = releaseDecision(plan.results);
    expect(decision.releasable).toBe(false);
    expect(decision.blockers.every((blocker) => blocker.refusal === "GATE_NOT_EVALUATED")).toBe(true);
  });

  it("still admits the gates nothing automated can settle, bounded by their own stated reason", () => {
    // The one automatic verdict, and it is the opposite kind from a pass. Each carries the admission from
    // the evidence table as its note, which is what `LAUNCH_READINESS.md` means by a limitation that is
    // "explicit, bounded and safe" — and a KNOWN_LIMITATION without a note is a blocker, so an empty
    // admission could not slip through.
    const plan = planGateResults({ commands: [] });
    const admitted = plan.results.filter((result) => result.severity === "KNOWN_LIMITATION");

    expect(admitted.map((result) => result.gateId).toSorted()).toEqual(["BOOKING", "OBSERVABILITY", "STAGING"]);
    expect(admitted.every((result) => (result.note ?? "").trim() !== "")).toBe(true);
  });
});

describe("a planner given a full, passing run", () => {
  it("passes the gates whose suites all ran, and records which commands they were", () => {
    const plan = planGateResults({ commands: everythingPassed });
    const privacy = plan.results.find((result) => result.gateId === "PRIVACY_DELETION");

    expect(privacy?.severity).toBe("PASS");
    expect(privacy?.evidence).toContain("ran: pnpm test:db");
    expect(privacy?.evidence).toContain("packages/db/src/privacy.integration.test.ts");
  });

  it("does not pass a gate its suites do not settle, even when they all passed", () => {
    // `AUTOPILOT_HEADLESS` has suites *and* an admission: the suites prove the worker runs without a
    // browser, and observing a full cycle with every dashboard closed needs a deployment. A planner that
    // reported PASS here would be claiming the deployment was observed.
    const plan = planGateResults({ commands: everythingPassed });
    const headless = plan.results.find((result) => result.gateId === "AUTOPILOT_HEADLESS");

    expect(headless?.severity).toBe("KNOWN_LIMITATION");
    expect(headless?.note).toContain("needs a deployment");
  });

  it("still cannot make the release approvable on its own, because §2 and §14 have nothing to run", () => {
    // Everything green and the decision is a releasable candidate carrying three admitted limitations.
    // That is the honest state of this repository, and it is what a release record should say.
    const plan = planGateResults({ commands: everythingPassed });
    const decision = releaseDecision(plan.results);

    expect(plan.omitted).toEqual([]);
    expect(decision.releasable).toBe(true);
    expect(decision.knownLimitations.map((limitation) => limitation.gateId)).toContain("STAGING");
  });
});

describe("a planner given a failing run", () => {
  it("blocks every gate the failed command covered, and names the command", () => {
    const plan = planGateResults({
      commands: [
        { command: "pnpm verify", exitCode: 0 },
        { command: "pnpm test:db", exitCode: 1 },
        { command: "pnpm test:e2e", exitCode: 0 },
      ],
    });
    const blocked = plan.results.filter((result) => result.severity === "BLOCKER");

    expect(blocked.map((result) => result.gateId)).toContain("PRIVACY_DELETION");
    expect(blocked.every((result) => result.evidence.includes("failed: pnpm test:db"))).toBe(true);
    expect(releaseDecision(plan.results).releasable).toBe(false);
  });

  it("does not block a gate that command does not cover", () => {
    // The failure has to land where it belongs. A planner that blocked everything would be as useless as
    // one that passed everything, and would train whoever reads it to stop reading.
    const plan = planGateResults({
      commands: [
        { command: "pnpm verify", exitCode: 0 },
        { command: "pnpm test:db", exitCode: 1 },
        { command: "pnpm test:e2e", exitCode: 0 },
      ],
    });

    expect(plan.results.find((result) => result.gateId === "UX_LOCALIZATION")?.severity).toBe("PASS");
  });
});

describe("a verdict somebody wrote down", () => {
  it("wins over anything derived, because a person who looked is better evidence than an exit code", () => {
    const plan = planGateResults({
      commands: everythingPassed,
      written: { PRIVACY_DELETION: { severity: "BLOCKER", evidence: "export omitted the transcript table; see the incident" } },
    });

    expect(plan.results.find((result) => result.gateId === "PRIVACY_DELETION")).toEqual({
      gateId: "PRIVACY_DELETION",
      severity: "BLOCKER",
      evidence: "export omitted the transcript table; see the incident",
    });
  });

  it("cannot admit a limitation without a bound, because the table supplies one or the decision refuses", () => {
    const plan = planGateResults({ commands: everythingPassed, written: { STAGING: { severity: "KNOWN_LIMITATION" } } });
    const staging = plan.results.find((result) => result.gateId === "STAGING");

    expect((staging?.note ?? "").trim()).not.toBe("");
    // And where the table has nothing to supply either, the decision is what refuses it.
    const undocumented = releaseDecision([{ gateId: "MESSAGING_E2E", severity: "KNOWN_LIMITATION", evidence: "skipped" }]);
    expect(undocumented.blockers).toContainEqual({ gateId: "MESSAGING_E2E", refusal: "LIMITATION_UNDOCUMENTED" });
  });

  it("can settle a gate nothing automated reaches, which is the point of being able to write one", () => {
    const plan = planGateResults({
      commands: everythingPassed,
      written: { STAGING: { severity: "PASS", evidence: "staging deployment 2026-10-08, smoke log attached" } },
    });

    expect(plan.results.find((result) => result.gateId === "STAGING")?.severity).toBe("PASS");
  });
});
