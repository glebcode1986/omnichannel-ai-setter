/** Runs every golden case and assembles the report. */
import { GOLDEN_CASES } from "./cases/index";
import { buildReport, type EvalReport } from "./report";
import { runCase, RUN_METADATA, type RunOptions } from "./run";
import type { GoldenCase } from "./case";

export interface SuiteOptions extends RunOptions {
  readonly cases?: readonly GoldenCase[];
  /** Identifies the provider under test in the report; defaults to the fixture. */
  readonly provider?: string;
  readonly model?: RunOptions["model"];
  readonly modelName?: string;
  readonly startedAt?: Date;
}

export async function runSuite(options: SuiteOptions = {}): Promise<EvalReport> {
  const cases = options.cases ?? GOLDEN_CASES;
  const duplicate = cases.map((kase) => kase.id).find((id, index, all) => all.indexOf(id) !== index);
  if (duplicate !== undefined) {
    // Two cases sharing an id would silently overwrite one another in any comparison across runs.
    throw new Error(`duplicate golden case id: ${duplicate}`);
  }
  const results = [];
  for (const kase of cases) {
    results.push(await runCase(kase, options));
  }
  return buildReport(results, {
    provider: options.provider ?? RUN_METADATA.provider,
    model: options.modelName ?? RUN_METADATA.model,
    promptVersion: RUN_METADATA.promptVersion,
    schemaVersion: RUN_METADATA.schemaVersion,
    startedAt: (options.startedAt ?? new Date()).toISOString(),
  });
}
