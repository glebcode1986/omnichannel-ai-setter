/**
 * Turning what was actually run into gate verdicts (#60, LAUNCH_READINESS.md §1 and §20).
 *
 * The spec's rule for this file is one sentence: "do not rely on 'Claude ran it locally' without recorded
 * commands/results". So the single property worth stating about everything below is what it *cannot* do.
 *
 * **It cannot manufacture a `PASS`.** A gate is passed only when a command that actually runs its suites
 * was run and succeeded, or when a person wrote the verdict down. A gate with suites nobody ran comes back
 * as omitted — which `releaseDecision` reports as `GATE_NOT_EVALUATED`, a blocker — and a gate whose
 * covering command failed comes back `BLOCKER` with that command named. There is no path through this
 * module that produces a pass from an absence.
 *
 * The one automatic verdict it does produce is the opposite kind: a gate that nothing automated can
 * settle, and that says so in `GATE_EVIDENCE`, becomes a `KNOWN_LIMITATION` carrying that admission as
 * its note. That is the spec's own category — a limitation admitted explicitly and bounded — and making
 * it automatic is what stops twenty gates from needing twenty hand-typed sentences that drift from the
 * table they were copied out of.
 */
import { RELEASE_GATES, type GateResult, type GateSeverity } from "../../packages/domain/src/release";

import { evidenceLineFor, GATE_EVIDENCE } from "./evidence";

/**
 * Which command runs which suites.
 *
 * Derived from the path, because that is what the root `package.json` scripts actually select on:
 * `pnpm test:db` runs the `@omnichannel/db` project, `pnpm test:e2e` runs the two app projects, and
 * `pnpm verify` runs everything that needs no infrastructure. A suite under a prefix this does not know
 * is reported rather than assumed covered.
 */
const COMMAND_FOR_PREFIX: readonly { readonly prefix: string; readonly command: string }[] = [
  { prefix: "packages/db/", command: "pnpm test:db" },
  { prefix: "apps/worker/", command: "pnpm test:e2e" },
  { prefix: "apps/web/", command: "pnpm test:e2e" },
  { prefix: "packages/", command: "pnpm verify" },
  { prefix: "scripts/", command: "pnpm verify" },
];

export function commandForSuite(suite: string): string | undefined {
  return COMMAND_FOR_PREFIX.find((entry) => suite.startsWith(entry.prefix))?.command;
}

/** One command that was run, and whether it succeeded. The evidence §1 asks to be recorded. */
export interface CommandRun {
  readonly command: string;
  readonly exitCode: number;
}

/** A verdict a person wrote down, for a gate no command can settle. */
export interface WrittenVerdict {
  readonly severity: GateSeverity;
  readonly evidence?: string;
  readonly note?: string;
}

export interface ReleasePlan {
  readonly results: readonly GateResult[];
  /** Gates with no verdict at all. `releaseDecision` turns each into `GATE_NOT_EVALUATED`. */
  readonly omitted: readonly string[];
  /** Suites named by a gate that no known command runs. Reported rather than silently treated as covered. */
  readonly unroutedSuites: readonly string[];
}

/**
 * Assembles the gate results for a release candidate.
 *
 * Precedence, and it is deliberate: a written verdict always wins, because a person who looked is better
 * evidence than a command that merely exited zero. Everything else is derived.
 */
export function planGateResults(input: {
  readonly commands: readonly CommandRun[];
  readonly written?: Readonly<Record<string, WrittenVerdict>>;
}): ReleasePlan {
  const results: GateResult[] = [];
  const omitted: string[] = [];
  const unroutedSuites: string[] = [];
  const written = input.written ?? {};
  const outcome = new Map(input.commands.map((run) => [run.command, run.exitCode]));

  for (const gate of RELEASE_GATES) {
    const entry = GATE_EVIDENCE[gate.id] ?? {};
    const line = evidenceLineFor(gate.id);
    const byHand = written[gate.id];
    if (byHand !== undefined) {
      results.push({
        gateId: gate.id,
        severity: byHand.severity,
        evidence: (byHand.evidence ?? "").trim() === "" ? line : (byHand.evidence ?? "").trim(),
        ...(byHand.severity === "KNOWN_LIMITATION"
          ? { note: (byHand.note ?? "").trim() === "" ? (entry.manual ?? "admitted without a stated bound") : (byHand.note ?? "").trim() }
          : (byHand.note ?? "").trim() === ""
            ? {}
            : { note: (byHand.note ?? "").trim() }),
      });
      continue;
    }

    const suites = entry.suites ?? [];
    if (suites.length === 0) {
      // Nothing automated settles it. If the table says so in as many words, that admission is the
      // verdict; if it does not, the gate is omitted and the release is blocked until somebody says.
      if ((entry.manual ?? "").trim() !== "") {
        results.push({ gateId: gate.id, severity: "KNOWN_LIMITATION", evidence: line, note: (entry.manual ?? "").trim() });
      } else {
        omitted.push(gate.id);
      }
      continue;
    }

    const commands = new Set<string>();
    let routed = true;
    for (const suite of suites) {
      const command = commandForSuite(suite);
      if (command === undefined) {
        unroutedSuites.push(`${gate.id} -> ${suite}`);
        routed = false;
        continue;
      }
      commands.add(command);
    }
    const unrun = [...commands].filter((command) => !outcome.has(command));
    const failed = [...commands].filter((command) => (outcome.get(command) ?? 0) !== 0);
    if (failed.length > 0) {
      results.push({ gateId: gate.id, severity: "BLOCKER", evidence: `${line} | failed: ${failed.join(", ")}` });
      continue;
    }
    if (!routed || unrun.length > 0) {
      // Not a pass and not a blocker: nobody ran the thing that would have answered it. Omitted, which
      // `releaseDecision` reports as `GATE_NOT_EVALUATED` — and silence is not a pass.
      omitted.push(gate.id);
      continue;
    }
    // Every command covering this gate's suites was run and succeeded. The one place a pass comes from.
    const passEvidence = `${line} | ran: ${[...commands].toSorted().join(", ")}`;
    if ((entry.manual ?? "").trim() !== "") {
      // Suites passed *and* there is something they do not settle. The spec's own category.
      results.push({ gateId: gate.id, severity: "KNOWN_LIMITATION", evidence: passEvidence, note: (entry.manual ?? "").trim() });
      continue;
    }
    results.push({ gateId: gate.id, severity: "PASS", evidence: passEvidence });
  }

  return { results, omitted, unroutedSuites };
}
