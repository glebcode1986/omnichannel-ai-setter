/**
 * No new conditional spread may hide a misspelled key in a query filter.
 *
 * The type checker cannot enforce this — that is the whole finding — so the gate has to be a test. It runs
 * the audit over every workspace project (about seven seconds, no database) and holds two lines:
 *
 * 1. **No exposed spread in a `filter` position.** This is the one with teeth. A key that vanishes from a
 *    Prisma `where` does not fail, it widens the query, which is how a paged read once returned another
 *    Business Profile's rows. Every such site is guarded, and a new one fails here.
 * 2. **A ceiling on the rest.** `write` and `value` positions are not all guarded yet; the ceiling stops
 *    the number growing while that work is outstanding. Lower it when you guard more; raising it needs a
 *    reason in the pull request.
 *
 * A guard is `satisfies` on the spread's branch. `spread-key-audit.ts` explains why that works where the
 * bare literal does not, and `spread-key-audit.test.ts` pins the classifier that decides all of this.
 */
import path from "node:path";

import { describe, expect, it } from "vitest";

import { auditProject, repoRoot, type SpreadSite } from "./spread-key-audit.ts";
import { PROJECTS } from "./spread-key-projects.ts";

/**
 * The highest number of exposed `write` and `value` spreads this repository may carry.
 *
 * Measured at the commit that introduced this gate. It is a ceiling, not a target: every one of these is a
 * key a rename would drop silently, and the reason they are not guarded yet is review size, not safety.
 */
const EXPOSED_CEILING = 461;

/**
 * Two conditional spreads in one object literal that write the same key, each one reviewed.
 *
 * The later spread replaces the earlier one's value outright, so when both conditions hold the first is
 * gone — and no type check can see it, because each spread is valid on its own. Whether that is a defect
 * depends on something only a reader knows: whether the two conditions can be true at once.
 *
 * - `inbox-view.ts` — **benign.** Both arms test `view.filter` against a different literal, and it holds
 *   one value, so the two can never both apply.
 * - `review-queue-store.ts` — **a real defect, reported and not fixed here.** `channelAccountId` and
 *   `reviewMode` are independent fields of `ReviewQueueFilter`; with both set, the channel filter is
 *   silently dropped and the queue answers for every channel. No production caller passes either field
 *   today (`reviewFilterOf` sets only `reasonCode` and `stale`) and no test sets both, which is why it
 *   has never been seen. Fixing it changes behaviour and belongs in its own change with its own test.
 */
const REVIEWED_COLLISIONS = new Set([
  'apps/web/src/server/inbox-view.ts:66+67 takeover',
  'packages/db/src/review-queue-store.ts:156+157 conversation',
]);

function allSites(): readonly SpreadSite[] {
  const seen = new Set<string>();
  const sites: SpreadSite[] = [];
  for (const project of PROJECTS) {
    for (const site of auditProject(path.join(repoRoot, project))) {
      const id = `${site.file}:${site.line}`;
      if (!seen.has(id)) {
        seen.add(id);
        sites.push(site);
      }
    }
  }
  return sites;
}

describe("conditional spreads that hide a misspelled key", () => {
  const sites = allSites();
  const exposed = sites.filter((site) => site.verdict === "exposed");

  it("finds sites at all, so a silent classifier cannot pass this gate", () => {
    expect(sites.length).toBeGreaterThan(100);
  });

  it("leaves no query filter unguarded", () => {
    const unguarded = exposed
      .filter((site) => site.role === "filter")
      .map((site) => `${site.file}:${site.line} (${site.keys.join(",")})`);
    expect(unguarded, "add `satisfies <the Prisma where type>` to the spread's branch").toEqual([]);
  });

  it("finds no unreviewed pair of spreads writing the same key", () => {
    const byContainer = new Map<string, SpreadSite[]>();
    for (const site of sites) {
      byContainer.set(site.container, [...(byContainer.get(site.container) ?? []), site]);
    }
    const found: string[] = [];
    for (const [, group] of byContainer) {
      const first = new Map<string, SpreadSite>();
      for (const site of group) {
        for (const key of site.keys) {
          const earlier = first.get(key);
          if (earlier !== undefined && earlier.line !== site.line) {
            found.push(`${site.file}:${earlier.line}+${site.line} ${key}`);
          }
          first.set(key, site);
        }
      }
    }
    expect(found.filter((entry) => !REVIEWED_COLLISIONS.has(entry))).toEqual([]);
  });

  it("still sees the pairs it has reviewed, so the allowlist cannot go stale unnoticed", () => {
    const byContainer = new Map<string, SpreadSite[]>();
    for (const site of sites) {
      byContainer.set(site.container, [...(byContainer.get(site.container) ?? []), site]);
    }
    const found = new Set<string>();
    for (const [, group] of byContainer) {
      const first = new Map<string, SpreadSite>();
      for (const site of group) {
        for (const key of site.keys) {
          const earlier = first.get(key);
          if (earlier !== undefined && earlier.line !== site.line) {
            found.add(`${site.file}:${earlier.line}+${site.line} ${key}`);
          }
          first.set(key, site);
        }
      }
    }
    // An entry that no longer matches means the code moved or was fixed: remove it rather than carry it.
    expect([...REVIEWED_COLLISIONS].filter((entry) => !found.has(entry))).toEqual([]);
  });

  it("does not let the unguarded write and value positions grow", () => {
    const remaining = exposed.filter((site) => site.role !== "filter");
    expect(remaining.length).toBeLessThanOrEqual(EXPOSED_CEILING);
  });
});
