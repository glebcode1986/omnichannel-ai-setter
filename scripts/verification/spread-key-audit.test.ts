/**
 * The classifier is pinned to behaviour, not to a count.
 *
 * The report's numbers move with every commit, so a test that asserted them would be rewritten rather
 * than read. What must not drift is the judgement: that a spread into a Prisma `where` is a `filter`, that
 * a spread into `Readonly<Record<string, unknown>>` is a no-op worth excluding, that a `satisfies` branch
 * counts as guarded, and that a branch writing no key at all is not a site. Each fixture case exists to
 * make exactly one of those true.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { auditProject, repoRoot, type SpreadSite } from "./spread-key-audit.ts";

const fixtureDirectory = path.join(repoRoot, "scripts/verification/fixtures/spread-keys");
const fixtureSource = readFileSync(path.join(fixtureDirectory, "sites.ts"), "utf8").split("\n");

/** The audit filters fixtures out of the product report, so the test points the program at them directly. */
const sites = auditProject(path.join(fixtureDirectory, "tsconfig.json"), { includeFixtures: true });

function siteOn(fragment: string): SpreadSite {
  const index = fixtureSource.findIndex((line) => line.includes(fragment));
  expect(index, `fixture no longer contains ${fragment}`).toBeGreaterThanOrEqual(0);
  const found = sites.filter((site) => site.line === index + 1);
  expect(found, `expected exactly one site on the line holding ${fragment}`).toHaveLength(1);
  return found[0] as SpreadSite;
}

describe("the spread-key classifier", () => {
  it("finds every fixture site and nothing else", () => {
    expect(sites).toHaveLength(7);
  });

  it("calls a spread into a Prisma where a filter, which is the costly position", () => {
    const site = siteOn("findMany({ where: { ...(tenantId === undefined ? {} : { tenantId }) } });");
    expect(site.role).toBe("filter");
    expect(site.keys).toEqual(["tenantId"]);
  });

  it("does not call a site exposed when the weak-type rule would refuse it on its own", () => {
    // Same call as above, and the verdict turns on nothing but whether a known sibling is present.
    expect(siteOn("findMany({ where: { ...(tenantId === undefined ? {} : { tenantId }) } });")).toMatchObject({
      verdict: "weakTypeMayCatch",
    });
  });

  it("calls the same spread exposed as soon as one sibling key is spelled right", () => {
    expect(siteOn("findMany({ where: { state: \"s\"")).toMatchObject({ verdict: "exposed", role: "filter" });
  });

  it("separates a write from a filter, because losing a key costs a column rather than a scope", () => {
    expect(siteOn('writeRow({ data:')).toMatchObject({ verdict: "exposed", role: "write" });
  });

  it("treats an ordinary object as a value", () => {
    expect(siteOn("take({ id: \"r1\", ...(label === undefined ? {} : { label }) })")).toMatchObject({
      verdict: "exposed",
      role: "value",
    });
  });

  it("excuses a target that accepts any key, where a guard would assert nothing", () => {
    expect(siteOn('log({ event: "x"')).toMatchObject({ verdict: "indexSignature" });
  });

  it("counts a satisfies branch as already guarded", () => {
    expect(siteOn('satisfies Pick<Row, "label">')).toMatchObject({ verdict: "guarded" });
  });

  it("ignores a spread whose branches write no key, which cannot carry a misspelling", () => {
    const index = fixtureSource.findIndex((line) => line.includes("return { ...(flag ? {} : {}) }"));
    expect(index).toBeGreaterThanOrEqual(0);
    expect(sites.filter((site) => site.line === index + 1)).toHaveLength(0);
  });

  it("reads a `&&` spread as well as a ternary, since both forms appear in the codebase", () => {
    expect(siteOn("...(label !== undefined && { label })")).toMatchObject({ verdict: "exposed" });
  });
});
