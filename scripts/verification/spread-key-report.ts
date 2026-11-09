/**
 * The report `pnpm audit:spread-keys` prints, and the ratchet that keeps the guarded count from slipping.
 *
 * `--max-unguarded <n>` exits non-zero when more than `n` guardable spreads are unguarded, which is how a
 * package that has been cleaned stays clean: a new `...(cond ? {} : { typo: value })` raises the count and
 * fails the gate, where the type checker alone says nothing. See `spread-key-audit.ts` for why the count
 * has to come from the checker rather than from a text search.
 */
import path from "node:path";

import { auditProject, repoRoot, type SpreadRole, type SpreadSite, type SpreadVerdict } from "./spread-key-audit.ts";
import { PROJECTS } from "./spread-key-projects.ts";


const VERDICTS: readonly SpreadVerdict[] = ["exposed", "guarded", "weakTypeMayCatch", "indexSignature", "noContextualType"];

function counts(sites: readonly SpreadSite[]): Readonly<Record<SpreadVerdict, number>> {
  const tally: Record<SpreadVerdict, number> = { exposed: 0, guarded: 0, weakTypeMayCatch: 0, indexSignature: 0, noContextualType: 0 };
  for (const site of sites) {
    tally[site.verdict] += 1;
  }
  return tally;
}

function main(): void {
  const argv = process.argv.slice(2);
  const limitIndex = argv.indexOf("--max-unguarded");
  const limit = limitIndex === -1 ? undefined : Number(argv[limitIndex + 1]);
  const listGuardable = argv.includes("--list");

  // One file can be reached by two projects (a package and the app importing it); count each site once.
  const seen = new Set<string>();
  const all: SpreadSite[] = [];
  for (const project of PROJECTS) {
    for (const site of auditProject(path.join(repoRoot, project))) {
      const id = `${site.file}:${site.line}`;
      if (!seen.has(id)) {
        seen.add(id);
        all.push(site);
      }
    }
  }

  const byPackage = new Map<string, SpreadSite[]>();
  for (const site of all) {
    const owner = site.file.split("/").slice(0, 2).join("/");
    byPackage.set(owner, [...(byPackage.get(owner) ?? []), site]);
  }

  process.stdout.write(`${"package".padEnd(26)}${VERDICTS.map((v) => v.padStart(17)).join("")}\n`);
  for (const [owner, sites] of [...byPackage.entries()].sort()) {
    const tally = counts(sites);
    process.stdout.write(`${owner.padEnd(26)}${VERDICTS.map((v) => String(tally[v]).padStart(17)).join("")}\n`);
  }
  const total = counts(all);
  process.stdout.write(`${"TOTAL".padEnd(26)}${VERDICTS.map((v) => String(total[v]).padStart(17)).join("")}\n`);
  process.stdout.write(`\nsites in all: ${all.length}\n`);

  // What a dropped key costs, over the guardable sites only — the ones a guard would actually change.
  const exposed = all.filter((site) => site.verdict === "exposed");
  const roles: readonly SpreadRole[] = ["filter", "write", "value"];
  process.stdout.write("\nexposed by role (what losing the key does)\n");
  for (const role of roles) {
    const sites = exposed.filter((site) => site.role === role);
    process.stdout.write(`  ${role.padEnd(8)} ${String(sites.length).padStart(4)}\n`);
  }

  // Two conditional spreads in one literal writing the same key: the later one wins and the earlier
  // filter disappears when both conditions hold. No type check can see it, so the audit must.
  const byContainer = new Map<string, SpreadSite[]>();
  for (const site of all) {
    byContainer.set(site.container, [...(byContainer.get(site.container) ?? []), site]);
  }
  const collisions: string[] = [];
  for (const [, group] of byContainer) {
    const seenKey = new Map<string, SpreadSite>();
    for (const site of group) {
      for (const key of site.keys) {
        const first = seenKey.get(key);
        if (first !== undefined && first.line !== site.line) {
          collisions.push(`${site.file}:${first.line} and :${site.line} both write "${key}" (${site.role})`);
        }
        seenKey.set(key, site);
      }
    }
  }
  process.stdout.write(`\nsame key written by two spreads in one literal: ${collisions.length}\n`);
  for (const collision of collisions) {
    process.stdout.write(`  ${collision}\n`);
  }

  if (listGuardable) {
    const wanted = argv[argv.indexOf("--list") + 1];
    for (const site of exposed
      .filter((site) => wanted === undefined || wanted.startsWith("--") || site.role === wanted)
      .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
      process.stdout.write(`  ${site.role.padEnd(6)} ${site.file}:${site.line}  keys=${site.keys.join(",")}\n`);
    }
  }

  if (limit !== undefined && total.exposed > limit) {
    process.stderr.write(`\n${total.exposed} exposed spreads, limit is ${limit}\n`);
    process.exit(1);
  }
}

main();
