/**
 * Every integration suite must be reachable from the verification gate.
 *
 * `pnpm verify` runs the whole test run without a database or Redis, so every DB-backed suite skips
 * there by design; the infrastructure scripts are what actually execute them. That leaves one silent
 * failure mode, and it happened: a new integration suite was added to a workspace project that no
 * infrastructure script names, so it reported "5 skipped" in a green CI run and the defect it reproduces
 * was never exercised in the review gate.
 *
 * A skipped suite and a passing suite look the same from a summary line. This test is the difference.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
/** The scripts whose job is to run suites that need real infrastructure. */
const INFRASTRUCTURE_SCRIPTS = ["test:db", "test:redis", "test:e2e"] as const;
const INTEGRATION_SUITE = /\.integration\.test\.ts$/;

interface Manifest {
  readonly name?: string;
  readonly scripts?: Readonly<Record<string, string>>;
}

function readManifest(directory: string): Manifest {
  return JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")) as Manifest;
}

/** Vitest project names named by `--project <name>` across the infrastructure scripts. */
function coveredProjects(root: Manifest): Set<string> {
  const covered = new Set<string>();
  for (const script of INFRASTRUCTURE_SCRIPTS) {
    const command = root.scripts?.[script] ?? "";
    for (const match of command.matchAll(/--project[= ]([^\s]+)/g)) {
      covered.add(match[1] ?? "");
    }
  }
  return covered;
}

function integrationSuitesUnder(directory: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      if (entry === "node_modules" || entry.startsWith(".")) {
        continue;
      }
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (INTEGRATION_SUITE.test(entry)) {
        found.push(path.relative(repoRoot, full));
      }
    }
  };
  walk(directory);
  return found;
}

/** Every workspace package that owns at least one integration suite, by its package name. */
function projectsWithIntegrationSuites(): Map<string, string[]> {
  const byProject = new Map<string, string[]>();
  for (const group of ["apps", "packages"]) {
    const groupDir = path.join(repoRoot, group);
    for (const entry of readdirSync(groupDir)) {
      const packageDir = path.join(groupDir, entry);
      if (!statSync(packageDir).isDirectory()) {
        continue;
      }
      const suites = integrationSuitesUnder(path.join(packageDir, "src"));
      if (suites.length === 0) {
        continue;
      }
      const name = readManifest(packageDir).name;
      expect(name, `${group}/${entry} has no package name`).toBeDefined();
      byProject.set(name ?? "", suites);
    }
  }
  return byProject;
}

describe("the verification gate", () => {
  it("runs every project that owns an integration suite", () => {
    const covered = coveredProjects(readManifest(repoRoot));
    const owners = projectsWithIntegrationSuites();

    // Not vacuous: if this ever finds nothing, the walk is broken rather than the repo being clean.
    expect(owners.size).toBeGreaterThan(0);
    for (const [project, suites] of owners) {
      expect(
        covered,
        `${project} owns ${String(suites.length)} integration suite(s) (${suites[0] ?? ""}) that no infrastructure script runs; add it to one of ${INFRASTRUCTURE_SCRIPTS.join(", ")}`,
      ).toContain(project);
    }
  });

  it("names the infrastructure requirement in the scripts that run those suites", () => {
    const root = readManifest(repoRoot);

    // A suite that needs a database must fail when there is none, not skip: REQUIRE_* is what turns a
    // missing service into an error instead of a green run that proved nothing.
    for (const script of INFRASTRUCTURE_SCRIPTS) {
      const command = root.scripts?.[script] ?? "";
      expect(command, `${script} is missing`).not.toBe("");
      expect(command, `${script} must require its infrastructure rather than skip`).toMatch(/REQUIRE_(DB|REDIS)_TESTS=1/);
    }
  });
});
