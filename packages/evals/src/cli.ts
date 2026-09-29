/**
 * One command: `pnpm evals`.
 *
 * Writes the machine-readable report to `--json <path>` when asked and the human-readable one to stdout,
 * and exits non-zero when any assertion failed. Quality regressions are printed but do not change the exit
 * code — a heuristic grader should not be able to block a release by itself.
 */
import { writeFileSync } from "node:fs";
import process from "node:process";

import { formatReport } from "./report";
import { runSuite } from "./suite";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const jsonIndex = args.indexOf("--json");
  const jsonPath = jsonIndex === -1 ? undefined : args[jsonIndex + 1];

  const report = await runSuite();
  if (jsonPath !== undefined) {
    writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${formatReport(report)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}

await main();
