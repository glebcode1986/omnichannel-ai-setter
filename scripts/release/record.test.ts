/**
 * What the release recorder refuses to attest (#60).
 *
 * Astra's P1 on PR #103: `--sha` named the candidate with nothing tying it to the checkout that was
 * actually verified. The CLI would accept a forty-character string that exists nowhere, run its
 * verification against whatever tree it was invoked in, file the migration list of `HEAD` under that
 * other name, and print `releasable`. Imported command results were a bare `[{command, exitCode}]`, which
 * is indistinguishable from the same array copied out of a run against any other commit.
 *
 * These cases drive the real CLI as a process, because the defect lived in argument handling and exit
 * codes rather than in a function anybody could call. `--dry-run` writes nothing and needs no database.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim();
const scratch = mkdtempSync(path.join(tmpdir(), "release-record-"));

/** Runs the recorder exactly as an operator would, and never writes: `--dry-run` throughout. */
function record(...args: readonly string[]): { readonly status: number; readonly output: string } {
  const result = spawnSync(
    "node",
    ["--import", "tsx", "scripts/release/record.ts", "--dry-run", "--allow-dirty", "--rollback-plan", "p", "--summary", "s", ...args],
    { cwd: repoRoot, encoding: "utf8" },
  );
  return { status: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
}

function resultsFile(name: string, body: unknown): string {
  const file = path.join(scratch, name);
  writeFileSync(file, JSON.stringify(body), "utf8");
  return file;
}

const passing = [
  { command: "pnpm verify", exitCode: 0 },
  { command: "pnpm test:db", exitCode: 0 },
  { command: "pnpm test:e2e", exitCode: 0 },
];

describe("the candidate a release record names", () => {
  it("refuses a SHA that is not a commit in this repository", () => {
    // The reviewer's own probe. It used to exit 0 and print that candidate as releasable.
    const run = record("--stage", "COMMERCIAL_BETA", "--sha", "a".repeat(40), "--command-results", resultsFile("fake.json", { sha: "a".repeat(40), reference: "nowhere", commands: passing }));

    expect(run.status).toBe(2);
    expect(run.output).toContain("is not a commit in this repository");
  });

  it("refuses a SHA that is not even shaped like one", () => {
    const run = record("--stage", "INTERNAL", "--sha", "HEAD~1");

    expect(run.status).toBe(2);
    expect(run.output).toContain("full 40-character commit id");
  });

  it("refuses to verify this checkout while naming a different candidate", () => {
    // No `--command-results`, so the commands would run here. Attesting another commit with this tree's
    // run is the shape the whole finding is about.
    //
    // The other commit is built rather than looked up: `HEAD~1` does not resolve in CI, where the
    // checkout is shallow, and `git rev-parse` prints an unresolvable argument back verbatim instead of
    // failing loudly — so the test used to hand the CLI the string "HEAD~1" and watch it refuse for the
    // wrong reason. `commit-tree` writes a real, parentless commit object from the tree already here: it
    // exists, it is a valid candidate, and it is not HEAD, at any clone depth.
    const other = spawnSync("git", ["commit-tree", `${head}^{tree}`, "-m", "a commit that is not HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).stdout.trim();
    expect(other, "the probe commit must have been written").toMatch(/^[0-9a-f]{40}$/u);

    const run = record("--stage", "INTERNAL", "--sha", other);

    expect(run.status).toBe(2);
    expect(run.output).toContain("is not HEAD");
  });
});

describe("the evidence a release record imports", () => {
  it("refuses a bare array, which cannot say which commit produced it", () => {
    const run = record("--stage", "COMMERCIAL_BETA", "--sha", head, "--command-results", resultsFile("bare.json", passing));

    expect(run.status).toBe(2);
    expect(run.output).toContain("bare array");
  });

  it("refuses results recorded against another commit", () => {
    const other = `${"b".repeat(39)}c`;
    const run = record("--stage", "COMMERCIAL_BETA", "--sha", head, "--command-results", resultsFile("other.json", { sha: other, reference: "actions run 1", commands: passing }));

    expect(run.status).toBe(2);
    expect(run.output).toContain("results from another commit are not evidence about this one");
  });

  it("refuses results that do not say where they ran", () => {
    const run = record("--stage", "COMMERCIAL_BETA", "--sha", head, "--command-results", resultsFile("noref.json", { sha: head, commands: passing }));

    expect(run.status).toBe(2);
    expect(run.output).toContain("where those commands ran");
  });

  it("accepts an envelope that names this candidate, and still refuses the release on its own", () => {
    // The success control, and the second half of the other P1 in one assertion: a complete, honest
    // envelope gets through the identity checks and the candidate is still not releasable, because three
    // successful commands do not evidence staging, the AI evaluation or observability.
    const run = record("--stage", "COMMERCIAL_BETA", "--sha", head, "--command-results", resultsFile("ok.json", { sha: head, reference: "actions run 39836168590", commands: passing }));

    expect(run.output).toContain(`release candidate ${head}`);
    expect(run.output).toContain("not evaluated: STAGING");
    expect(run.output).toContain("not evaluated: AI_REGRESSION");
    expect(run.status).not.toBe(0);
  });
});
