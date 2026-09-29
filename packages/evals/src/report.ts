/**
 * Turning results into something a machine can diff and a person can read (P2-08).
 *
 * Both outputs carry the provider, model, prompt and schema versions the run used. That is what lets two
 * runs be compared without touching the goldens: a drop in scores after a model swap is a fact about the
 * model, and without the versions recorded it would look like a fact about the suite.
 *
 * The gate is deliberately asymmetric. **Any assertion failure fails the run** — those are decisions with
 * one correct answer. A quality score below its threshold is reported as a regression but does not fail on
 * its own, because a grader is a heuristic and heuristics should not be able to block a release by
 * themselves.
 */
import type { CaseResult } from "./run";

export interface EvalRunMetadata {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly startedAt: string;
}

export interface EvalReport {
  readonly metadata: EvalRunMetadata;
  readonly totals: {
    readonly cases: number;
    readonly passed: number;
    readonly failed: number;
    readonly qualityRegressions: number;
  };
  readonly cases: readonly CaseResult[];
  /** False when any assertion failed. Quality regressions are reported but never fail a run alone. */
  readonly ok: boolean;
}

export function buildReport(results: readonly CaseResult[], metadata: EvalRunMetadata): EvalReport {
  const failed = results.filter((result) => result.failures.length > 0);
  const qualityRegressions = results.filter((result) => result.qualityBelowThreshold);
  return {
    metadata,
    totals: { cases: results.length, passed: results.length - failed.length, failed: failed.length, qualityRegressions: qualityRegressions.length },
    cases: results,
    ok: failed.length === 0,
  };
}

/** A concise human-readable summary. Failures are shown in full; passing cases are one line each. */
export function formatReport(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`AI evaluation — ${report.metadata.provider}/${report.metadata.model}`);
  lines.push(`prompt ${report.metadata.promptVersion}, schema ${report.metadata.schemaVersion}, started ${report.metadata.startedAt}`);
  lines.push("");

  for (const result of report.cases) {
    if (result.failures.length > 0) {
      lines.push(`FAIL  ${result.id}  (${result.category})`);
      lines.push(`      ${result.intent}`);
      for (const failure of result.failures) {
        lines.push(`      - ${failure}`);
      }
      continue;
    }
    const scores = result.scores.map((entry) => `${entry.grader} ${entry.score.toFixed(2)}`).join(", ");
    const warn = result.qualityBelowThreshold ? "  [quality below threshold]" : "";
    lines.push(`pass  ${result.id}${scores === "" ? "" : `  (${scores})`}${warn}`);
  }

  lines.push("");
  lines.push(
    `${String(report.totals.passed)}/${String(report.totals.cases)} passed, ` +
      `${String(report.totals.failed)} failed, ${String(report.totals.qualityRegressions)} quality regression(s)`,
  );
  if (!report.ok) {
    lines.push("");
    lines.push("Assertions are decisions with one correct answer. A failure here is a behaviour change, not a score.");
  }
  return lines.join("\n");
}
