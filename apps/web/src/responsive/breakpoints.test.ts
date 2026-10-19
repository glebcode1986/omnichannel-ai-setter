/**
 * Responsive behaviour, at the widths this product claims to support (Issue #35).
 *
 * **What this can and cannot prove.** jsdom evaluates no media queries and lays nothing out, so no test
 * in this repository can assert that a page *looks* right at 375px. A test that pretended to would be
 * worse than none, because it would be cited as coverage.
 *
 * What it proves instead is that the rules which make each surface usable narrow still exist, still name
 * the classes and attributes the components actually render, and still cover every surface — which is the
 * way this breaks in practice. A renamed class leaves a phone showing two panes on top of each other, and
 * nothing type-checks the join between a stylesheet, a component and a route.
 *
 * The widths and the remaining limitations are written down in `docs/specs/UX_VERIFICATION.md`.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(path.join(srcRoot, "app/globals.css"), "utf8");

/** The breakpoints this product supports, and what each is for. */
const BREAKPOINTS = [
  { maxWidth: 720, what: "phone: the shell's navigation stops being a sidebar" },
  { maxWidth: 900, what: "phone and small tablet: two-pane surfaces become one pane at a time" },
] as const;

/** Representative widths, named so the spec and the test cannot drift apart. */
export const TESTED_WIDTHS = [
  { name: "phone", width: 375 },
  { name: "large phone", width: 430 },
  { name: "tablet", width: 768 },
  { name: "small laptop", width: 1024 },
  { name: "desktop", width: 1440 },
] as const;

/** The rules that apply at a given width: every narrow-screen block whose bound it is under. */
function rulesAt(width: number): string {
  return BREAKPOINTS.filter((breakpoint) => width <= breakpoint.maxWidth)
    .map((breakpoint) => {
      const start = css.indexOf(`@media (max-width: ${String(breakpoint.maxWidth)}px)`);
      expect(start, `the ${String(breakpoint.maxWidth)}px block must exist — ${breakpoint.what}`).toBeGreaterThan(-1);
      // To the end of the file is deliberate: there are two 900px blocks, and a rule in either counts.
      return css.slice(start);
    })
    .join("\n");
}

function componentSources(): string {
  const collected: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const full = path.join(directory, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry)) {
        collected.push(readFileSync(full, "utf8"));
      }
    }
  };
  walk(path.join(srcRoot, "app"));
  walk(path.join(srcRoot, "ui"));
  return collected.join("\n");
}

describe("the supported widths", () => {
  it("declares every breakpoint the product relies on", () => {
    for (const breakpoint of BREAKPOINTS) {
      expect(css, breakpoint.what).toContain(`@media (max-width: ${String(breakpoint.maxWidth)}px)`);
    }
  });

  it("has narrow-screen rules at every width below a tablet, and none needed above", () => {
    for (const { name, width } of TESTED_WIDTHS) {
      const rules = rulesAt(width);
      if (width <= 720) {
        expect(rules.length, `${name} (${String(width)}px) must pick up both narrow blocks`).toBeGreaterThan(0);
        expect(rules).toContain("@media (max-width: 720px)");
        expect(rules).toContain("@media (max-width: 900px)");
      } else if (width <= 900) {
        expect(rules).toContain("@media (max-width: 900px)");
        expect(rules).not.toContain("@media (max-width: 720px)");
      } else {
        // A desktop uses the base rules only. If a narrow block ever applied here, a full-width layout
        // would silently collapse into a phone one.
        expect(rules, `${name} (${String(width)}px) must not pick up a narrow block`).toBe("");
      }
    }
  });

  it("collapses the shell's sidebar on a phone", () => {
    const rules = rulesAt(375);

    // The sidebar is a grid column at desktop width. On a phone it has to stop being one, or the content
    // has 375 minus 232 pixels to live in.
    expect(rules).toMatch(/\.shell\b[\s\S]{0,400}grid-template-columns/);
    expect(css).toContain("--shell-nav-width");
  });

  it("gives every two-pane surface a one-pane rule, and nothing claims a pane it does not render", () => {
    const rules = rulesAt(375);
    const components = componentSources();

    // Each surface that shows a list beside a detail. A new one added without a narrow rule shows both
    // panes squeezed side by side on a phone, which is how this has broken before.
    for (const pane of ["inbox", "review", "leads"]) {
      expect(rules, `${pane} must have a narrow-screen rule`).toContain(pane);
    }
    // The attribute the routes set to say which pane they are. The stylesheet keys off it, so a rename in
    // either place is silent.
    expect(rules).toContain("data-pane");
    expect(components).toContain('data-pane="thread"');
    expect(components).toContain('data-pane="list"');
  });

  it("keeps a way back to the list on a phone, where the list is a separate screen", () => {
    const rules = rulesAt(375);
    const components = componentSources();

    // On a desktop the list is already on screen and this link is redundant; on a phone it is the only
    // way back. It therefore exists always and is hidden by the wide rules, not the narrow ones.
    expect(components).toContain('data-inbox-back="true"');
    expect(css).toContain(".inbox-back");
    expect(rules).toContain(".inbox-back");
  });

  it("lets a wide table scroll rather than overflow the page", () => {
    // The analytics and audit surfaces are tables with five and six columns. At 375px a table cannot
    // reflow, so it has to be allowed to scroll inside its panel — otherwise it pushes the whole
    // document sideways and every other surface goes with it.
    expect(css).toMatch(/overflow-x:\s*auto/);
  });

  it("names its own tested widths, so the spec cannot drift from the test", () => {
    const spec = readFileSync(path.resolve(srcRoot, "../../../docs/specs/UX_VERIFICATION.md"), "utf8");

    for (const { width } of TESTED_WIDTHS) {
      expect(spec, `UX_VERIFICATION.md must list ${String(width)}px`).toContain(`${String(width)}px`);
    }
    for (const breakpoint of BREAKPOINTS) {
      expect(spec).toContain(`${String(breakpoint.maxWidth)}px`);
    }
  });
});
