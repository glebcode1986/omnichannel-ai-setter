/**
 * `pnpm release:record` — runs the verification, judges the launch gates and records a release candidate
 * (#60, LAUNCH_READINESS.md §1, §18 and §20).
 *
 * This is the producer §20 asks for. Before it existed the release tables, the gate catalogue, the
 * severity model and the §18 send gate were all reachable only from tests: a deployment could never
 * record a release, so the stage in force was always "none", and "none" is the one state in which the
 * rollout gate permits everybody. The evidence half of the issue was a schema nobody could write to.
 *
 * What it does, in order:
 *
 * 1. Resolves the exact SHA from git, and refuses a dirty working tree — §1's "exact immutable release
 *    SHA" is not a property of a commit you have edited since.
 * 2. Runs the verification commands, unless told that CI already did and given their results.
 * 3. Asks `planGateResults` for the verdicts. It cannot manufacture a pass; see that module's header.
 * 4. Prints the decision, every blocker and every admitted limitation.
 * 5. Records the candidate, with its actor and an audit row, unless `--dry-run`.
 *
 * It records a candidate that failed its gates, deliberately — "recording that a commit failed its gates
 * is the entire point of the record" — and exits non-zero so a pipeline stops. `--dry-run` writes nothing
 * and is the honest way to ask "what would this release say".
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { createDbClient } from "../../packages/db/src/client.ts";
import { authorizePlatformAccess } from "../../packages/db/src/platform-tenancy.ts";
import { recordRelease } from "../../packages/db/src/release-store.ts";
import { isRolloutStage, releaseDecision, worstSeverity } from "../../packages/domain/src/release.ts";
import { planGateResults, type CommandRun, type WrittenVerdict } from "./plan.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");

/** The commands whose results the gate verdicts are derived from. */
const VERIFICATION_COMMANDS = ["pnpm verify", "pnpm test:db", "pnpm test:e2e"] as const;

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline !== undefined) {
    return inline.slice(prefix.length);
  }
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function present(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function git(...args: readonly string[]): string {
  const result = spawnSync("git", [...args], { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function runCommands(): CommandRun[] {
  return VERIFICATION_COMMANDS.map((command) => {
    const [executable, ...args] = command.split(" ");
    process.stdout.write(`\n$ ${command}\n`);
    const result = spawnSync(executable ?? "pnpm", args, { cwd: repoRoot, stdio: "inherit" });
    return { command, exitCode: result.status ?? 1 };
  });
}

const stage = flag("stage");
if (stage === undefined || !isRolloutStage(stage)) {
  console.error("--stage is required and must be one of INTERNAL, DESIGN_PARTNERS_DRAFT, LIMITED_AUTOPILOT, COMMERCIAL_BETA, GENERAL_AVAILABILITY");
  process.exit(2);
}
const rollbackPlan = flag("rollback-plan");
const summary = flag("summary");
if ((rollbackPlan ?? "").trim() === "" || (summary ?? "").trim() === "") {
  console.error("--rollback-plan and --summary are required: a release nobody can explain, or cannot get back from, is not one to record as considered");
  process.exit(2);
}

const sha = flag("sha") ?? git("rev-parse", "HEAD");
const dirty = git("status", "--porcelain");
if (dirty !== "" && !present("allow-dirty")) {
  console.error(`the working tree has uncommitted changes, so ${sha.slice(0, 7)} is not what would be deployed:\n${dirty}`);
  console.error("commit them, or pass --allow-dirty if you are recording a candidate about a commit you have checked out cleanly elsewhere");
  process.exit(2);
}

/**
 * Reads a JSON file the operator supplied.
 *
 * Cast through `unknown` and in one place, so the trust in a hand-written file is a single stated
 * assumption rather than an `any` spreading through the script. What the file cannot do is widen the
 * decision: a severity the domain does not define is refused by `recordRelease`, a gate id it does not
 * define is refused there too, and the enum columns are checked again on the way back out.
 */
function readJsonFile<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

const verdictsFile = flag("verdicts");
const written: Readonly<Record<string, WrittenVerdict>> = verdictsFile === undefined ? {} : readJsonFile<Readonly<Record<string, WrittenVerdict>>>(verdictsFile);

const resultsFile = flag("command-results");
const commands: CommandRun[] = resultsFile === undefined ? runCommands() : readJsonFile<CommandRun[]>(resultsFile);

const plan = planGateResults({ commands, written });
const decision = releaseDecision(plan.results);

process.stdout.write(`\nrelease candidate ${sha} at ${stage}\n`);
for (const run of commands) {
  process.stdout.write(`  ${run.exitCode === 0 ? "ok  " : "FAIL"} ${run.command}\n`);
}
for (const gateId of plan.omitted) {
  process.stdout.write(`  not evaluated: ${gateId}\n`);
}
for (const suite of plan.unroutedSuites) {
  process.stdout.write(`  no command runs this suite: ${suite}\n`);
}
for (const limitation of decision.knownLimitations) {
  process.stdout.write(`  known limitation: ${limitation.gateId} — ${limitation.note}\n`);
}
for (const blocker of decision.blockers) {
  process.stdout.write(`  blocker: ${blocker.gateId} (${blocker.refusal})\n`);
}
if (decision.disabledCapabilities.length > 0) {
  process.stdout.write(`  disabled by a HIGH: ${decision.disabledCapabilities.join(", ")}\n`);
}
// The worst thing in the set, printed before the verdict: a release manager reading one line wants to
// know how bad it is, and "releasable: true with nine admitted limitations" is a different sentence from
// "releasable: true".
process.stdout.write(`  worst severity: ${worstSeverity(plan.results)}\n`);
process.stdout.write(`  releasable: ${decision.releasable}\n`);

if (present("dry-run")) {
  process.stdout.write("\n--dry-run: nothing recorded\n");
  process.exit(decision.releasable ? 0 : 1);
}

const actorUserId = flag("actor") ?? process.env["RELEASE_ACTOR_USER_ID"];
if ((actorUserId ?? "").trim() === "") {
  console.error("--actor or RELEASE_ACTOR_USER_ID is required: a release names the person who proposed it, and that person needs OPERATE_RELEASE");
  process.exit(2);
}
const connectionString = process.env["DATABASE_URL"];
if ((connectionString ?? "").trim() === "") {
  console.error("DATABASE_URL is required to record a release");
  process.exit(2);
}

const db = createDbClient({ connectionString: connectionString ?? "" });
try {
  const context = await authorizePlatformAccess(db, actorUserId ?? "");
  const recorded = await recordRelease(db, context, {
    sha,
    stage,
    rollbackPlan: (rollbackPlan ?? "").trim(),
    summary: (summary ?? "").trim(),
    migrations: git("ls-tree", "--name-only", "HEAD", "packages/db/prisma/migrations/").split("\n").filter(Boolean),
    enabledFlags: (flag("enabled-flags") ?? "").split(",").map((entry) => entry.trim()).filter(Boolean),
    results: plan.results,
  });
  process.stdout.write(`\nrecorded ${recorded.releaseId} for ${recorded.sha} at ${recorded.stage}\n`);
  if (!recorded.decision.releasable) {
    process.stdout.write("this candidate is recorded and is not releasable; the record is the point\n");
  }
  process.stdout.write("it is in force only once an independent reviewer files a PASS for this exact SHA\n");
  process.exit(recorded.decision.releasable ? 0 : 1);
} finally {
  await db.$disconnect();
}
