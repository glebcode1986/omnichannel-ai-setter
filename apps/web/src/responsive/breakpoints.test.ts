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

/**
 * Every surface that renders a `<table>`, and how each survives a phone. A table cannot reflow by
 * itself: either it stops being a table, or it scrolls inside a boundary its container declares.
 *
 * This list exists because the assertion it replaced — `css` matches `overflow-x: auto` anywhere — was
 * green while `.lead-table` was 490px wide at 375px and pushed the whole document sideways. One
 * declaration, somewhere in sixteen hundred lines, answered for every table in the product.
 */
const TABLE_SURFACES = [
  { container: ".lead-table", treatment: "reflows", what: "five columns, and the only lead view on a phone" },
  { container: ".stage-config", treatment: "scrolls", what: "a grid of inputs and order controls" },
  { container: ".metric-panel", treatment: "scrolls", what: "analytics, five columns" },
  { container: ".audit-log", treatment: "scrolls", what: "the audit trail, six columns" },
] as const;

/** Representative widths, named so the spec and the test cannot drift apart. */
export const TESTED_WIDTHS = [
  { name: "phone", width: 375 },
  { name: "large phone", width: 430 },
  { name: "tablet", width: 768 },
  { name: "small laptop", width: 1024 },
  { name: "desktop", width: 1440 },
] as const;

/**
 * The body of every block in the stylesheet, brace-balanced, whose header matches `start`. Reading to a
 * matched closing brace rather than to the end of the file is the whole point: a slice to EOF makes the
 * rules "at 800px" contain every later block of any width, so an assertion that a 720px block does *not*
 * apply at 800px passes only while no 720px block happens to sit below a 900px one.
 */
function balancedBodies(start: string): string[] {
  const bodies: string[] = [];
  let from = 0;
  for (;;) {
    const head = css.indexOf(start, from);
    if (head === -1) {
      return bodies;
    }
    const open = css.indexOf("{", head);
    let depth = 0;
    let at = open;
    for (; at < css.length; at += 1) {
      if (css[at] === "{") {
        depth += 1;
      } else if (css[at] === "}") {
        depth -= 1;
        if (depth === 0) {
          break;
        }
      }
    }
    bodies.push(css.slice(open + 1, at));
    from = at + 1;
  }
}

/** The stylesheet with every narrow-screen block removed: what a desktop alone is served. */
const baseCss = BREAKPOINTS.reduce((text, breakpoint) => {
  const header = `@media (max-width: ${String(breakpoint.maxWidth)}px)`;
  let stripped = text;
  for (;;) {
    const head = stripped.indexOf(header);
    if (head === -1) {
      return stripped;
    }
    const open = stripped.indexOf("{", head);
    let depth = 0;
    let at = open;
    for (; at < stripped.length; at += 1) {
      if (stripped[at] === "{") {
        depth += 1;
      } else if (stripped[at] === "}") {
        depth -= 1;
        if (depth === 0) {
          break;
        }
      }
    }
    stripped = stripped.slice(0, head) + stripped.slice(at + 1);
  }
}, css);

/** The selector whose block contains this offset — the rule's own owner, read from the stylesheet. */
function selectorOwning(text: string, offset: number): string {
  const before = text.slice(0, offset);
  const open = before.lastIndexOf("{");
  // Past the end of whichever came last, and `*/` is two characters wide — off by one here puts the tail
  // of a comment at the front of the selector.
  const previous = Math.max(before.lastIndexOf("}") + 1, before.lastIndexOf("*/") + 2, 0);
  const [first = ""] = before.slice(previous, open).trim().split(",");
  return first.trim();
}

/** The narrowest declared bound whose block gives this selector a rule matching `declaration`. */
function boundOf(selector: string, declaration: RegExp): number | null {
  for (const breakpoint of BREAKPOINTS) {
    const block = balancedBodies(`@media (max-width: ${String(breakpoint.maxWidth)}px)`).join("\n");
    if (declaration.test(declarationsFor(selector, block))) {
      return breakpoint.maxWidth;
    }
  }
  return null;
}

/** The rules that apply at a given width: every narrow-screen block whose bound it is under. */
function rulesAt(width: number): string {
  return BREAKPOINTS.filter((breakpoint) => width <= breakpoint.maxWidth)
    .map((breakpoint) => {
      // Every block of that width, not the first: there are several 900px blocks and a rule in any counts.
      const bodies = balancedBodies(`@media (max-width: ${String(breakpoint.maxWidth)}px)`);
      expect(bodies.length, `the ${String(breakpoint.maxWidth)}px block must exist — ${breakpoint.what}`).toBeGreaterThan(0);
      return bodies.join("\n");
    })
    .join("\n");
}

/**
 * Every declaration block whose selector list names exactly this selector. The match requires the
 * selector to be followed by a comma or the opening brace, so `.metric-panel table` does not answer for
 * `.metric-panel`: the question here is always what the *container* declares.
 */
function declarationsFor(selector: string, within: string = css): string {
  const head = new RegExp(`(?:^|[\n,{}])\\s*${selector.replace(/\./gu, "\\.")}\\s*(?:,[^{]*)?\\{`, "gu");
  const bodies: string[] = [];
  let found = head.exec(within);
  while (found !== null) {
    const open = within.indexOf("{", found.index);
    let depth = 0;
    let at = open;
    for (; at < within.length; at += 1) {
      if (within[at] === "{") {
        depth += 1;
      } else if (within[at] === "}") {
        depth -= 1;
        if (depth === 0) {
          break;
        }
      }
    }
    bodies.push(within.slice(open + 1, at));
    head.lastIndex = at + 1;
    found = head.exec(within);
  }
  return bodies.join("\n");
}

/** Every filter bar in the product, taken out of the component sources. */
function filterForms(): string[] {
  return [...componentSources().matchAll(/<form[^>]*className="inbox-search"[\s\S]*?<\/form>/gu)].map((found) => found[0]);
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
      // Which blocks apply, by their bound. Asked of the widths rather than of the joined text: the text
      // is the blocks' contents, and a block's own header is not inside it.
      const applied = BREAKPOINTS.filter((breakpoint) => width <= breakpoint.maxWidth).map((breakpoint) => breakpoint.maxWidth);

      if (width <= 720) {
        expect(applied, `${name} (${String(width)}px) must pick up both narrow blocks`).toEqual([720, 900]);
        expect(rulesAt(width).length).toBeGreaterThan(0);
      } else if (width <= 900) {
        expect(applied, `${name} (${String(width)}px) is past the phone block`).toEqual([900]);
      } else {
        // A desktop uses the base rules only. If a narrow block ever applied here, a full-width layout
        // would silently collapse into a phone one.
        expect(applied, `${name} (${String(width)}px) must not pick up a narrow block`).toEqual([]);
        expect(rulesAt(width)).toBe("");
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

  it("gives the two-pane surface a one-pane rule, and nothing claims a pane it does not render", () => {
    const rules = rulesAt(375);
    const components = componentSources();

    // The inbox is the one surface that shows a list beside a detail. This list used to name "review" and
    // "leads" as well, and passed on a substring found outside any narrow block — review is a single
    // column of cards and the leads board is hidden below 900px, so neither was ever the thing at risk.
    expect(rules, "the inbox must have a narrow-screen rule").toContain(".inbox");
    expect(declarationsFor(".review-queue"), "review is a single column, not two panes").toMatch(
      /flex-direction:\s*column/u,
    );

    // The attribute the routes set to say which pane they are. The stylesheet keys off it, so a rename in
    // either place is silent.
    expect(rules).toContain("data-pane");
    expect(components).toContain('data-pane="thread"');
    expect(components).toContain('data-pane="list"');
  });

  it("leaves no fixed multi-column grid standing on a phone", () => {
    const narrow = rulesAt(375);

    // The invariant the list above cannot express: a grid whose columns carry a width cannot fit a phone,
    // whoever adds it. `repeat(auto-fit, …)` collapses by itself and `1fr auto` is two flexible columns,
    // so neither is at risk. What remains must be overridden in a narrow block — and the search runs over
    // the base rules only, since a grid declared inside a narrow block is already the override.
    const fixed = [...baseCss.matchAll(/grid-template-columns:\s*(?<columns>[^;]+);/gu)].filter((found) => {
      const columns = found.groups?.columns ?? "";
      return !columns.includes("repeat(auto-fit") && (/\d(?:px|rem|em|ch)/u.test(columns) || columns.includes("var(--"));
    });

    expect(fixed.length, "the shell and the inbox are the fixed grids this product has").toBe(2);
    for (const found of fixed) {
      const owner = selectorOwning(baseCss, found.index);
      expect(narrow, `${owner} has fixed columns (${(found.groups?.columns ?? "").trim()}) and must be overridden on a phone`).toContain(owner);
    }
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

  it("gives each table its own way to survive a phone, named one by one", () => {
    const narrow = rulesAt(375);

    for (const { container, treatment, what } of TABLE_SURFACES) {
      expect(css, `${container} must be styled at all`).toContain(container);

      if (treatment === "scrolls") {
        expect(declarationsFor(container), `${container} must be the scroll boundary — ${what}`).toMatch(
          /overflow-x:\s*auto/u,
        );
        continue;
      }

      // Reflow: the element itself stops being a table below the breakpoint, so there is nothing left to
      // overflow. Asked of the container's own rule — a selector list that merely mentions its name while
      // styling the cells leaves the table box intact, and the cards break while the name is still there.
      expect(declarationsFor(container, narrow), `${container} must stop being a table on a phone — ${what}`).toMatch(
        /display:\s*(?:block|grid|flex)/u,
      );
    }
  });

  it("lets the filter row wrap by itself, with no width to get wrong", () => {
    // Three hand-picked widths were wrong in turn. A 720px viewport rule left the row broken at 768 and
    // at 900, where the sidebar still takes 232px of the window. A container query at 820px fixed those
    // and left the settings page — seven fields, needing 1320px — broken at 1280 and at 1440. A row that
    // wraps has no width to pick, and nothing to get wrong when someone adds an eighth field.
    expect(declarationsFor(".inbox-search"), "the row must wrap on its own").toMatch(
      /grid-template-columns:\s*repeat\(auto-fit/u,
    );
    expect(declarationsFor(".inbox-search .field"), "a field is one element").toMatch(/display:\s*grid/u);

    // No breakpoint of any kind may speak for it. That is the claim, and it is the whole claim.
    expect(rulesAt(375), "no viewport rule may decide the filter row").not.toContain(".inbox-search");
    expect(css, "and no container query either").not.toContain("@container");
  });

  it("keeps each label and its control one element, which is what lets the row wrap", () => {
    // CSS pairs no siblings. The old grid paired them by flowing down two rows and across, and that is
    // exactly why it could not wrap. The pairing lives in the markup now, so the markup has to hold it:
    // one stray control outside a field is a column of its own again, in every filter bar it appears in.
    const forms = filterForms();
    expect(forms.length, "the filter bars this product renders").toBeGreaterThan(0);

    for (const form of forms) {
      const labels = [...form.matchAll(/<label htmlFor=/gu)].length;
      const fields = [...form.matchAll(/<div className="field">/gu)].length;
      expect(fields, `a filter bar with ${String(labels)} labels needs ${String(labels)} fields`).toBe(labels);
    }
  });

  it("gives every row that cannot wrap a way out", () => {
    const narrow = rulesAt(375);

    // The invariant behind every phone and tablet bug in this file's history: a grid with
    // `grid-auto-flow: column` grows a new column per child and never wraps, so it must scroll inside a
    // boundary or be hidden — or its widest child decides the width of the page. The filter row used to
    // be the second of these and is no longer one at all. Comments are stripped before the scan, since
    // this file's own prose quotes the property it searches for.
    const declarations = baseCss.replace(/\/\*[\s\S]*?\*\//gu, "");
    const owners = [...declarations.matchAll(/grid-auto-flow:\s*column/gu)].map((found) => selectorOwning(declarations, found.index));
    expect(owners, "the lead board is the only one left").toEqual([".lead-board"]);

    for (const owner of owners) {
      const scrolls = /overflow-x:\s*auto/u.test(declarationsFor(owner));
      const hidden = /display:\s*none/u.test(declarationsFor(owner, narrow));
      expect(scrolls && hidden, `${owner} cannot wrap, so it needs both a scroll boundary and a narrow rule`).toBe(true);
    }
  });

  it("reflows the lead table from the width the board stops being shown", () => {
    // The band between two bounds is where this broke and where no other assertion looks: the board was
    // hidden below 900px, the table became cards below 720px, and at 768px — a width this product claims
    // to support — the table was the only view of a lead and 117px wider than the room the shell left it.
    const hidesBoard = boundOf(".lead-board", /display:\s*none/u);
    const reflowsTable = boundOf(".lead-table", /display:\s*block/u);

    expect(hidesBoard, "the board must be hidden somewhere").not.toBeNull();
    expect(reflowsTable, "a view that is the only one has to fit, from the width it becomes the only one").toBe(hidesBoard);
  });

  it("labels every cell of a lead card with its own column name", () => {
    const narrow = rulesAt(375);
    const board = readFileSync(path.join(srcRoot, "ui/leads/lead-board.tsx"), "utf8");

    // The cards read their labels out of the markup. Nothing type-checks that join: drop the attribute
    // and the stylesheet renders empty labels, drop the rule and the values lose their names.
    expect(narrow, "the cards take their labels from the markup").toMatch(/content:\s*attr\(data-label\)/u);

    // Each label is the header's own message key, so a translated table stays translated as cards.
    for (const key of ["tableHeadStage", "tableHeadOwner", "tableHeadNext", "tableHeadUpdated"]) {
      expect(board, `leads.${key} must label its cell`).toContain(`data-label={t.t("leads.${key}")}`);
    }

    // One label per column, less the row header: that one is the card's title and names itself.
    const headers = [...board.matchAll(/<th scope="col">/gu)].length;
    const labelled = [...board.matchAll(/data-label=/gu)].length;
    expect(labelled, `${String(headers)} columns, so ${String(headers - 1)} cells need a label`).toBe(headers - 1);
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
