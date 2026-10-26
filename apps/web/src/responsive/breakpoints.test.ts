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
 *
 * `tableClass` is the class on the `<table>` itself where it has one, and a test below holds this list
 * against the markup: a classed table missing from here fails rather than going unnoticed, which is how
 * `.admin-audit` shipped with no styles at all. The entries with `tableClass: null` wrap tables that
 * carry no class of their own and are styled through the panel they sit in.
 */
const TABLE_SURFACES = [
  { container: ".lead-table", tableClass: "lead-table", treatment: "reflows", what: "five columns, and the only lead view on a phone" },
  { container: '.card[data-admin="audit"]', tableClass: "admin-audit", treatment: "scrolls", what: "the platform audit, six columns" },
  { container: ".stage-config", tableClass: null, treatment: "scrolls", what: "a grid of inputs and order controls" },
  { container: ".metric-panel", tableClass: null, treatment: "scrolls", what: "analytics, five columns" },
  { container: ".audit-log", tableClass: null, treatment: "scrolls", what: "the audit trail, six columns" },
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
  // Every regular-expression character is escaped, not only the dot: a selector may carry an
  // attribute, and `[data-admin="audit"]` read as a character class matches almost nothing.
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const head = new RegExp(`(?:^|[\n,{}])\\s*${escaped}\\s*(?:,[^{]*)?\\{`, "gu");
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

/**
 * Controls that take a cell in the grid. A hidden input is excluded on purpose rather than by oversight:
 * the browser's own stylesheet gives it `display: none`, so it is not a grid item and carrying state in
 * one outside a field costs nothing. Every filter bar here has at least one.
 */
function visibleControls(text: string): number {
  return [...text.matchAll(/<(?:input|select|textarea)\b[^>]*>/gu)].filter((found) => !found[0].includes('type="hidden"')).length;
}

/** The bodies of the `field` wrappers in one form, read to their matching closing tag. */
function balancedDivs(form: string): string[] {
  const found: string[] = [];
  const opener = /<div className="field">/gu;
  let at = opener.exec(form);
  while (at !== null) {
    let depth = 0;
    let i = at.index;
    for (; i < form.length; i += 1) {
      if (form.startsWith("<div", i)) {
        depth += 1;
      } else if (form.startsWith("</div>", i)) {
        depth -= 1;
        if (depth === 0) {
          break;
        }
      }
    }
    found.push(form.slice(at.index, i + "</div>".length));
    opener.lastIndex = i + 1;
    at = opener.exec(form);
  }
  return found;
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
    // Read out of the stylesheet, not recomputed from BREAKPOINTS: filtering the same constant with the
    // same predicate the branches use proves only that `filter` works. A bound the stylesheet declares and
    // this file does not — a stray 1100px block — is exactly what that version could not see, and it would
    // hand a 1024px laptop the collapsed phone shell.
    const declared = [...css.matchAll(/@media \(max-width: (?<bound>\d+)px\)/gu)]
      .map((found) => Number(found.groups?.bound))
      .filter((bound, at, all) => all.indexOf(bound) === at)
      .sort((a, b) => a - b);

    expect(declared, "every bound in the stylesheet is one this file knows about").toEqual(
      BREAKPOINTS.map((breakpoint) => breakpoint.maxWidth),
    );

    for (const { name, width } of TESTED_WIDTHS) {
      const applied = declared.filter((bound) => width <= bound);

      if (width <= 720) {
        expect(applied, `${name} (${String(width)}px) must pick up both narrow blocks`).toEqual([720, 900]);
        expect(rulesAt(width).length).toBeGreaterThan(0);
      } else if (width <= 900) {
        expect(applied, `${name} (${String(width)}px) is past the phone block`).toEqual([900]);
        expect(rulesAt(width), "and still gets the tablet block").not.toBe("");
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
    // has 375 minus 232 pixels to live in. Asked of `.shell`'s own rule inside the narrow blocks: a
    // pattern like /\.shell\b[\s\S]*grid-template-columns/ matches `.shell-nav` followed by any later
    // rule's track list, so deleting the one override it exists to protect left it green.
    expect(declarationsFor(".shell", rules), "the shell must drop to one column on a phone").toMatch(
      /grid-template-columns:\s*1fr/u,
    );
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
      // The owner's own rule in the narrow blocks, not its name anywhere in them: `toContain(".shell")`
      // is answered by `.shell-nav`, so the backstop could not see the shell losing its override.
      expect(
        declarationsFor(owner, narrow),
        `${owner} has fixed columns (${(found.groups?.columns ?? "").trim()}) and must be overridden on a phone`,
      ).toMatch(/grid-template-columns:/u);
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

  it("knows about every table the product renders, so the list above cannot go stale", () => {
    // The list is hand-written, and a hand-written list of "every surface" is a claim that rots. It had
    // rotted already: `ui/admin/platform-audit-table.tsx` renders `<table className="admin-audit">`, the
    // class appeared nowhere in the stylesheet, and the audit page was drawn by the browser's defaults.
    const rendered = [...componentSources().matchAll(/<table className="(?<name>[\w-]+)"/gu)].map(
      (found) => found.groups?.name ?? "",
    );
    const known = TABLE_SURFACES.flatMap((surface) => (surface.tableClass === null ? [] : [surface.tableClass]));

    expect([...new Set(rendered)].sort(), "a classed table must be named above, with its treatment").toEqual(
      [...new Set(known)].sort(),
    );
  });

  it("lets a surface that renders what a person typed break a word that has nowhere to break", () => {
    // A track that can shrink still cannot wrap a token with no break opportunity in it. These are the
    // places a person's own text reaches a narrow column: a message, the context panel, and a lead's next
    // action, which is free text and is where someone pastes a link. Without this the card bursts
    // sideways and takes the document with it — the same failure as a grid that cannot wrap, one layer
    // down. `white-space: nowrap` surfaces are deliberately not in this list: they scroll inside a
    // boundary instead, which is checked above.
    const narrow = rulesAt(375);

    expect(declarationsFor(".message-text"), "a message is whatever the customer sent").toMatch(/overflow-wrap:\s*anywhere/u);
    expect(declarationsFor(".lead-table td", narrow), "a lead's next action is free text").toMatch(
      /overflow-wrap:\s*anywhere/u,
    );
  });

  it("caps every auto-fit floor at the container, not at a width it hopes for", () => {
    // The minimum in `minmax` is a floor the track keeps even when the container is narrower, so
    // `minmax(20rem, 1fr)` draws a 320px column inside a 288px box. The style page did exactly that at
    // 320px while every wider measurement was clean — a grid that is supposed to fit, not fitting.
    // Comments are stripped: the prose above that rule quotes the broken form on purpose.
    const declarations = css.replace(/\/\*[\s\S]*?\*\//gu, "");
    const floors = [...declarations.matchAll(/repeat\(auto-fit,\s*minmax\((?<floor>.+?),\s*1fr\)\)/gu)].map(
      (found) => (found.groups?.floor ?? "").trim(),
    );

    expect(floors.length, "the auto-fit grids this stylesheet declares").toBeGreaterThan(0);
    for (const floor of floors) {
      expect(floor, `${floor} is a floor the track keeps below the container's own width`).toMatch(
        /^min\(.+,\s*100%\)$/u,
      );
    }

    // `min-width` is the same promise made directly, and it breaks the same way: the review card leaves
    // 262px and its textarea asked for 18rem, so the form burst out of the card below a 346px viewport.
    // Either a floor is zero — the item may shrink — or it is capped at the container it lives in.
    const widths = [...declarations.matchAll(/min-width:\s*(?<floor>[^;]+);/gu)].map((found) => (found.groups?.floor ?? "").trim());
    expect(widths.length, "the declared minimum widths").toBeGreaterThan(0);
    for (const floor of widths) {
      expect(floor === "0" || /^min\(.+,\s*100%\)$/u.test(floor), `min-width: ${floor} is a width this element may not fit in`).toBe(
        true,
      );
    }
  });

  it("keeps each label and its control one element, which is what lets the row wrap", () => {
    // CSS pairs no siblings. The old grid paired them by flowing down two rows and across, and that is
    // exactly why it could not wrap. The pairing lives in the markup now, so the markup has to hold it:
    // one stray control outside a field is a column of its own again, in every filter bar it appears in.
    const forms = filterForms();
    expect(forms.length, "the filter bars this product renders").toBeGreaterThan(0);

    for (const form of forms) {
      const fields = balancedDivs(form);
      const labels = [...form.matchAll(/<label htmlFor=/gu)].length;
      expect(fields.length, `a filter bar with ${String(labels)} labels needs ${String(labels)} fields`).toBe(labels);

      // Counting the two is not enough: move a control out of its wrapper and the counts do not change
      // while the pairing is gone. So each field is read, and what is left outside them is read too.
      let inside = 0;
      for (const field of fields) {
        expect([...field.matchAll(/<label\b/gu)].length, "a field holds its own label").toBe(1);
        const controls = visibleControls(field);
        expect(controls, "a field holds its own control").toBe(1);
        inside += controls;
      }

      const outside = visibleControls(form) - inside;
      expect(outside, "a control outside a field is a column of its own again").toBe(0);
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
    // Matched without the closing bracket: these elements also carry a role attribute, and a pattern that
    // ends at `>` silently counts zero the moment one is added.
    const headers = [...board.matchAll(/<th scope="col"/gu)].length;
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
