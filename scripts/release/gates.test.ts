/**
 * The launch gates, the spec that defines them, and the suites that evidence them (#60).
 *
 * Three things are held together here, and all three are the kind that drift silently.
 *
 * **The catalogue and the document.** `RELEASE_GATES` is a closed list in `packages/domain`, and
 * `LAUNCH_READINESS.md` is twenty numbered sections. A gate added to the document that nobody adds to the
 * list is a gate no release report will ever mention; a gate invented in the list has no definition
 * anybody can read. This parses the document and compares.
 *
 * **Every gate and its evidence.** `GATE_EVIDENCE`, in `evidence.ts` beside this file, maps each gate to
 * the suites that exercise it, the implementation offered as evidence of itself, or a stated reason
 * nothing automated settles it. The last case is the valuable one: a report that quietly omitted a gate
 * would read as a report with nothing to say about it, and "nothing to say" is where an untested path
 * lives. So an unmapped gate fails here, and an unevidenced gate has to say so out loud.
 *
 * It lives in a module rather than in this file because the release script quotes it into the record's
 * own `evidence` column. A table only a test could read would have meant the record said whatever the
 * person running the release typed.
 *
 * **The suites named exist, and are suites.** A mapping that points at a deleted file is worse than no
 * mapping, because it reads as coverage — and so is one that points at a directory or at a production
 * source file, which is how §16's gate came to look covered by three files that are its implementation.
 * Every path is checked against the filesystem, and every path offered as a suite has to be a test file.
 *
 * This lives in `scripts/` rather than beside the domain for the reason the header of
 * `scripts/verification/gate.test.ts` gives about itself: the thing being checked is a property of the
 * repository, and `packages/domain` is pure — it has no Node types and cannot read a file.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { RELEASE_GATES, RELEASE_GATE_IDS } from "../../packages/domain/src/release";
import { automatedCoverageFor, evidenceLineFor, GATE_EVIDENCE } from "./evidence";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const specPath = path.join(repoRoot, "docs/specs/LAUNCH_READINESS.md");

/** Every `## <n>. <heading>` in the spec, which is how it numbers its gates. */
function specSections(): { readonly section: number; readonly heading: string }[] {
  return [...readFileSync(specPath, "utf8").matchAll(/^## (\d+)\.\s+(.+)$/gmu)].map((match) => ({
    section: Number(match[1]),
    heading: (match[2] ?? "").trim(),
  }));
}

describe("the launch gate catalogue", () => {
  it("is exactly the spec's own numbered sections, in its own order and wording", () => {
    // The only thing holding a closed list in code and a numbered document together.
    expect(RELEASE_GATES.map((gate) => ({ section: gate.section, heading: gate.heading }))).toEqual(specSections());
  });

  it("reads twenty sections, so an empty parse is not why that passed", () => {
    expect(specSections().length).toBe(20);
  });
});

describe("the evidence behind each gate", () => {
  it("names every gate, so none can be quietly omitted", () => {
    // A report that omits a gate reads as a report with nothing to say about it, and "nothing to say" is
    // where an untested path lives.
    expect(Object.keys(GATE_EVIDENCE).toSorted()).toEqual([...RELEASE_GATE_IDS].toSorted());
  });

  it("gives every gate either a suite or a stated reason there is none", () => {
    const silent = Object.entries(GATE_EVIDENCE).filter(
      ([, entry]) => (entry.suites ?? []).length === 0 && (entry.manual ?? "").trim() === "",
    );

    expect(
      silent.map(([gateId]) => gateId),
      "a gate with neither evidence nor an admission",
    ).toEqual([]);
  });

  it("points only at files that exist", () => {
    // A mapping pointing at a deleted file is worse than no mapping, because it reads as coverage.
    const missing: string[] = [];
    for (const [gateId, entry] of Object.entries(GATE_EVIDENCE)) {
      for (const file of [...(entry.suites ?? []), ...(entry.implementation ?? [])]) {
        if (!existsSync(path.join(repoRoot, file))) {
          missing.push(`${gateId} -> ${file}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it("lists only real test files under `suites`, and nothing else", () => {
    // The check that was missing, and the one that mattered. `existsSync` accepts a directory and a
    // production source file, so three implementation files under `suites` read as coverage and kept a
    // gate with no tests at all out of every list below. A suite is a file whose name says it is one.
    const notSuites: string[] = [];
    for (const [gateId, entry] of Object.entries(GATE_EVIDENCE)) {
      for (const suite of entry.suites ?? []) {
        const full = path.join(repoRoot, suite);
        if (!/\.test\.tsx?$/u.test(suite) || !statSync(full).isFile()) {
          notSuites.push(`${gateId} -> ${suite}`);
        }
      }
    }

    expect(notSuites, "a path offered as a suite that is not a test file").toEqual([]);
  });

  it("says out loud which gates no automated run can settle", () => {
    // Asserted as an exact list rather than counted, so a gate that quietly acquires or loses its
    // admission is a failing test. `LAUNCH_READINESS.md` admits a limitation only when it is "explicit,
    // bounded and safe", and this is where the explicit part lives.
    const admitted = Object.entries(GATE_EVIDENCE)
      .filter(([, entry]) => (entry.manual ?? "").trim() !== "")
      .map(([gateId]) => gateId)
      .toSorted();

    expect(admitted).toEqual(
      [
        "AI_REGRESSION",
        "AUTOPILOT_HEADLESS",
        "BILLING_ENTITLEMENT",
        "BOOKING",
        "KILL_SWITCHES",
        "LOAD_CONCURRENCY",
        "OBSERVABILITY",
        "PER_CUSTOMER_READINESS",
        "RELIABILITY_CHAOS",
        "STAGING",
      ].toSorted(),
    );
  });

  it("has exactly three gates with no automated coverage at all, and names them", () => {
    // Three, and the number is in the assertion rather than in a comment that disagreed with it. A
    // staging environment and a booking capability do not exist; §16's alerting is implemented but
    // nothing tests it, and before `implementation` was a separate field that third gate was hidden by
    // three source files sitting under `suites`.
    const unautomated = RELEASE_GATE_IDS.filter((gateId) => !automatedCoverageFor(gateId)).toSorted();

    expect(unautomated).toEqual(["BOOKING", "OBSERVABILITY", "STAGING"]);
  });

  it("produces a quotable evidence line for every gate, admissions included", () => {
    // What the release record stores. A line that quoted only the suites would be the "looks fine" the
    // spec refuses, dressed as a file list — so a gate with an admission must carry it into the record.
    const lines = RELEASE_GATE_IDS.map((gateId) => [gateId, evidenceLineFor(gateId)] as const);

    expect(lines.filter(([, line]) => line.trim() === "")).toEqual([]);
    for (const [gateId, line] of lines) {
      if ((GATE_EVIDENCE[gateId]?.manual ?? "").trim() !== "") {
        expect(line, gateId).toContain("not settled automatically:");
      }
    }
  });
});
