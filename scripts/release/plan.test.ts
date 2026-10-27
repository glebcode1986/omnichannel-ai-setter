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
import { GATE_EVIDENCE } from "./evidence";
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

    // Every gate, now — not only the ones with suites. A gate whose table entry merely *describes* what
    // is outstanding used to settle itself as an admitted limitation; it is unevaluated until a person
    // writes a verdict for it.
    expect(plan.omitted.toSorted()).toEqual(RELEASE_GATES.map((gate) => gate.id).toSorted());
    const decision = releaseDecision(plan.results);
    expect(decision.releasable).toBe(false);
    expect(decision.blockers.every((blocker) => blocker.refusal === "GATE_NOT_EVALUATED")).toBe(true);
  });

  it("admits nothing on its own, because a note about outstanding work is not somebody accepting it", () => {
    // This case used to assert the opposite, and the assertion was the defect (Astra's P1 on #103). The
    // evidence table's `manual` text says what is *not* settled — "no staging environment exists",
    // "`pnpm evals` is not run by CI", "all seven alerts are unevidenced" — and reading it as the verdict
    // on itself meant the repository's own description of unfinished work admitted that work as a bounded,
    // accepted limitation, with nobody having judged the gap. `LAUNCH_READINESS` asks for limitations that
    // are explicit, bounded **and safe**; only a person can supply the last one.
    const plan = planGateResults({ commands: [] });

    expect(plan.results.filter((result) => result.severity === "KNOWN_LIMITATION")).toEqual([]);
    for (const gateId of ["STAGING", "AI_REGRESSION", "OBSERVABILITY"]) {
      expect(plan.omitted, `${gateId} must be unevaluated until somebody judges it`).toContain(gateId);
    }
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

    // And it does not quietly file it as an accepted limitation either: the suites passing says nothing
    // about the thing the table says they do not cover, so the gate waits for a written verdict.
    expect(plan.results.find((result) => result.gateId === "AUTOPILOT_HEADLESS")).toBeUndefined();
    expect(plan.omitted).toContain("AUTOPILOT_HEADLESS");
    expect(GATE_EVIDENCE["AUTOPILOT_HEADLESS"]?.manual ?? "").toContain("needs a deployment");
  });

  it("cannot make a release approvable on its own, however green every command was", () => {
    // The case the whole finding is about, and the one a Commercial Beta would have walked through: three
    // successful commands, no written verdict anywhere, and the planner used to answer `releasable: true`
    // with AUTOPILOT enabled — while the staging gate's own note said no staging environment exists and
    // the AI evaluation gate's note said the golden-case suite is never run by CI.
    const plan = planGateResults({ commands: everythingPassed });
    const decision = releaseDecision(plan.results);

    expect(decision.releasable).toBe(false);
    expect(decision.disabledCapabilities).toEqual([]);
    for (const gateId of ["STAGING", "AI_REGRESSION", "OBSERVABILITY"]) {
      expect(plan.omitted).toContain(gateId);
      expect(decision.blockers.map((blocker) => blocker.gateId)).toContain(gateId);
    }
    expect(decision.blockers.filter((blocker) => blocker.gateId === "STAGING")[0]?.refusal).toBe("GATE_NOT_EVALUATED");
  });

  it("lets a person accept what they have judged, and switches off what their judgement did not cover", () => {
    // The other half, and the reason the gate above is a refusal rather than a wall: a written verdict is
    // how somebody records that they looked. `STAGING` guards the release itself, so accepting it has to
    // be a bounded limitation; `AI_REGRESSION` and `OBSERVABILITY` guard capabilities, so the honest
    // verdict for evidence nobody has is `HIGH` — which **disables** them rather than permitting them.
    const plan = planGateResults({
      commands: everythingPassed,
      written: {
        STAGING: { severity: "KNOWN_LIMITATION", evidence: "operator stood up staging and recorded the run", note: "bounded: smoke only, no provider credentials" },
        AI_REGRESSION: { severity: "HIGH", evidence: "`pnpm evals` was not run for this candidate" },
        OBSERVABILITY: { severity: "HIGH", evidence: "no alerting integration and no runbooks yet" },
      },
    });
    const decision = releaseDecision(plan.results);

    for (const gateId of ["STAGING", "AI_REGRESSION", "OBSERVABILITY"]) {
      expect(plan.omitted).not.toContain(gateId);
    }
    // Unattended sending is off because nobody evidenced the AI gate — the outcome the finding demands,
    // and the opposite of what a free-text note used to buy.
    expect(decision.disabledCapabilities).toContain("AUTOPILOT");
    expect(decision.disabledCapabilities).toContain("OPERATOR_VISIBILITY");
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
