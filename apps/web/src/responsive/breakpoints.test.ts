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
 *
 * `source` and `columns` are the width each surface actually needs, and a test below counts them out of
 * that component's own markup. They used to be a sentence — "the platform audit, six columns" — and three
 * of the four sentences were wrong: the audit renders four columns and severity is an attribute on the
 * row, the audit trail renders five, and `.metric-panel` has no five-column table at all but four tables
 * of which the widest has six. Nothing read those words, so nothing could disagree with them. A number a
 * test counts is a contract; a number in prose is a wish.
 */
const TABLE_SURFACES = [
  {
    container: ".lead-table",
    tableClass: "lead-table",
    treatment: "reflows",
    source: "ui/leads/lead-board.tsx",
    columns: [5],
    what: "the only lead view on a phone",
  },
  {
    container: '.card[data-admin="audit"]',
    tableClass: "admin-audit",
    treatment: "scrolls",
    source: "ui/admin/platform-audit-table.tsx",
    columns: [4],
    what: "the platform audit — severity is an attribute on the row, not a column",
  },
  {
    container: ".stage-config",
    tableClass: null,
    treatment: "scrolls",
    source: "ui/leads/stage-config.tsx",
    columns: [4],
    what: "a grid of inputs and order controls",
  },
  {
    container: ".metric-panel",
    tableClass: null,
    treatment: "scrolls",
    source: "ui/analytics/metrics-view.tsx",
    columns: [3, 3, 6],
    what: "analytics: three tables in one panel, and the widest decides whether the panel fits",
  },
  {
    container: ".audit-log",
    tableClass: null,
    treatment: "scrolls",
    source: "ui/analytics/audit-table.tsx",
    columns: [5],
    what: "the audit trail",
  },
] as const;

/**
 * The semantic columns of each `<table>` in a component, in source order.
 *
 * Counted from `<th scope="col">` rather than from `<th>`, because a row header is not a column, and read
 * per table rather than per file: `.metric-panel` holds four of them and it is the widest that decides
 * whether the panel fits. Splitting on `<table` gives each table the text up to the next one, and the last
 * its file's tail — which is sound here only because nothing follows the final `</table>` in these files.
 */
function columnsOf(source: string): number[] {
  return readFileSync(path.join(srcRoot, source), "utf8")
    .split("<table")
    .slice(1)
    .map((table) => [...table.matchAll(/<th scope="col"/gu)].length);
}

/** Representative widths, named so the spec and the test cannot drift apart. */
export const TESTED_WIDTHS = [
  { name: "phone", width: 375 },
  { name: "large phone", width: 430 },
  { name: "tablet", width: 768 },
  // Just past the width where the shell stops being one screen at a time: the narrowest window that
  // shows a list beside a thread, and where the thread used to have no content width at all.
  { name: "small tablet", width: 901 },
  { name: "small laptop", width: 1024 },
  { name: "desktop", width: 1440 },
  // The first width at which the main column is wide enough for all three panes.
  { name: "wide desktop", width: 1404 },
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
  // An at-rule's own brace, when this rule is nested inside one. Without it a rule inside a `@container`
  // or `@media` block reports its *prelude* as the selector — `"@container main (min-width: 1124px) {
  // .inbox"` rather than `".inbox"` — and an assertion asked about that owner is asked about a string
  // that matches nothing. For a rule that is not nested this lands before the previous `}` and the
  // `Math.max` below discards it.
  const enclosing = before.lastIndexOf("{", open - 1);
  // Past the end of whichever came last *before the rule's own brace*, and `*/` is two characters wide —
  // off by one here puts the tail of a comment at the front of the selector. The bound matters: these
  // used to be searched over the whole prefix, so a comment sitting *inside* the rule, after its brace,
  // moved the start of the selector past its end and the owner came back as the empty string.
  //
  // `declarationsFor("")` returns nothing — measured, zero characters, because no `{` in this stylesheet
  // is preceded by whitespace alone. So an unresolvable owner makes its assertion **fail**, loudly, which
  // is how this bug was caught: the owners-set assertion printed `[ "", ".inbox", ".shell" ]`. An earlier
  // version of this comment said such assertions "pass for the wrong reason", which is the opposite of
  // what happens, and a comment that calls a working check silent teaches the next reader to distrust it.
  const previous = Math.max(
    before.lastIndexOf("}", open - 1) + 1,
    before.lastIndexOf("*/", open - 1) + 2,
    enclosing + 1,
    0,
  );
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
 *
 * `Select` is in the list because it is one: the product's own select, a `role="combobox"` button with a
 * hidden input behind it, which occupies a cell exactly as the native control it replaced did. Leaving it
 * out would have made every converted row read as a row of empty labels — which is what happened, and is
 * why the analytics filters reported one control where there are eight.
 */
function visibleControls(text: string): number {
  return [...text.matchAll(/<(?:input|select|textarea|Select)\b[^>]*>/gu)].filter((found) => !found[0].includes('type="hidden"')).length;
}

/**
 * The filter rows this product renders, each with the selectors that have to make it wrap.
 *
 * Two of them, and for a while this file knew about one. Everything below spoke of "every filter bar it
 * appears in" while matching `className="inbox-search"` alone — so the analytics and audit row, which is
 * the widest one in the product at eight controls, was never read by any of it. It was a flexed card
 * with a 900px media query propping it up, which is the shape of the three defects the comments here
 * describe, and nothing could say so.
 */
const FILTER_ROWS = [
  { row: "inbox-search", field: ".inbox-search .field", what: "the Inbox, review, leads and knowledge rows" },
  { row: "filter-bar", field: ".filter-bar label", what: "the analytics and audit filters" },
  // Settings and Style moved off `inbox-search` onto `form-grid`, because that row hides its labels and
  // theirs are not redundant. Named here the same day they moved: a row that leaves this list keeps
  // working and stops being checked, and the sentence it left behind would have gone on claiming it.
  //
  // Three rows and not one, because `filterForms` finds a form by the class *on the form element*, and
  // these three carry different ones. The first draft named only `form-grid` and claimed the settings
  // form and the voice editors in its sentence — and neither is a `form-grid`: the settings form is a
  // `form-stack` of groups whose grids are `div`s inside it, and a voice editor is a `voice-layer`. A
  // mutation that pulled a control out of its wrapper on the settings form survived, which is how the
  // sentence was found to be describing coverage that did not exist.
  { row: "form-grid", field: ".form-grid .field", what: "the simulation, the style and knowledge testers, and the add-example form" },
  { row: "form-stack", layout: ".form-grid", field: ".form-grid .field", what: "the settings form, whose groups each hold a grid" },
  { row: "voice-layer", layout: ".form-grid", field: ".form-grid .field", what: "the two voice editors" },
] as const;

/**
 * The field wrappers in one form, each read to its matching closing tag and including its own tags.
 *
 * Two shapes count, because they are one claim. `.inbox-search` wraps a `<label htmlFor>` and its
 * control in a `div.field`; the analytics row uses a wrapping `<label>`, which already holds both. Either
 * way the pairing is in the markup, which is the whole invariant — CSS pairs no siblings, and a grid that
 * flowed a label and a control down two rows is precisely the layout that could not wrap.
 *
 * A `<label>` holding no control is the first half of a `div.field` pair rather than a field of its own,
 * so it is dropped here instead of being counted and then failed below.
 */
function balancedFields(form: string): string[] {
  const found: string[] = [];
  for (const [tag, opener] of [
    // `[^>]*` and not a literal `>`: a field that spans both columns carries `data-span="full"`, and an
    // exact-match opener skipped every one of them — which would have undercounted the fields of the
    // very forms this list is about to start reading.
    ["div", /<div className="field"[^>]*>/gu],
    ["label", /<label(?=[\s>])/gu],
  ] as const) {
    const close = `</${tag}>`;
    let at = opener.exec(form);
    while (at !== null) {
      let depth = 0;
      let i = at.index;
      for (; i < form.length; i += 1) {
        if (form.startsWith(`<${tag}`, i)) {
          depth += 1;
        } else if (form.startsWith(close, i)) {
          depth -= 1;
          if (depth === 0) {
            break;
          }
        }
      }
      found.push(form.slice(at.index, i + close.length));
      opener.lastIndex = i + 1;
      at = opener.exec(form);
    }
  }
  return found.filter((field) => visibleControls(field) > 0);
}

/** Every filter bar in the product, taken out of the component sources. */
function filterForms(): string[] {
  const sources = componentSources();
  return FILTER_ROWS.flatMap(({ row }) => [
    ...sources.matchAll(new RegExp(`<form[^>]*className="${row}"[\\s\\S]*?</form>`, "gu")),
  ]).map((found) => found[0]);
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
      /grid-template-columns:\s*(1fr|minmax\(0,\s*1fr\))/u,
    );
    expect(css).toContain("--shell-nav-width");
  });

  it("stacks the bar's two names on a phone, where a row loses both of them", () => {
    // The bar's other two items can give nothing back: a 36px menu button, and controls whose automatic
    // minimum size is their content. At 390px the row spends 16 + 36 + 12 + 184 + 16 and leaves the crumb
    // 114px — and flexbox shares a deficit in proportion to what each child asked for, so both names
    // ellipsize rather than only the longer one. Measured whole from 471px up, so every phone clipped, and
    // at that width the workspace name is on no other part of the screen.
    const phone = declarationsFor(".shell-crumb", rulesAt(375));

    expect(phone.trim(), "the phone block must declare the crumb at all").not.toBe("");
    expect(phone, "and it must stop being a row").toMatch(/flex-direction:\s*column/u);
    // `align-items` is the load-bearing half rather than tidiness: the base rule declares `baseline`,
    // which has no meaning on a column container's cross axis — it resolves to flex-start and sizes each
    // name to its own max-content instead of to the crumb, so a long profile name runs out past the
    // controls and takes the document sideways with it. Measured at 82px of horizontal scroll with a
    // 44-character name, which is why the ellipsis has to keep doing the work.
    expect(phone, "with each name pinned to the crumb's width rather than its own").toMatch(/align-items:\s*stretch/u);

    // The control, and the reason this is not a grep for three declarations: specificity is equal and a
    // media query adds none, so source order alone decides which wins. A desktop must still be served the
    // row — if the override were moved into the base rule, or written above it, this is what notices.
    const desktop = declarationsFor(".shell-crumb", baseCss);

    expect(desktop, "a desktop still gets the row").toMatch(/align-items:\s*baseline/u);
    expect(desktop, "and the column belongs to the phone block alone").not.toMatch(/flex-direction/u);
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
    // whoever adds it. `repeat(auto-fit, …)` and `repeat(auto-fill, …)` both collapse to one column by
    // themselves — they differ only in whether an *unoccupied* track keeps its size, which is a question
    // about a group with one field in it and not about whether a phone fits — and `1fr auto` is two
    // flexible columns,
    // so neither is at risk. What remains must be overridden in a narrow block — and the search runs over
    // the base rules only, since a grid declared inside a narrow block is already the override.
    const fixed = [...baseCss.matchAll(/grid-template-columns:\s*(?<columns>[^;]+);/gu)].filter((found) => {
      const columns = found.groups?.columns ?? "";
      return !/repeat\(auto-(?:fit|fill)/u.test(columns) && (/\d(?:px|rem|em|ch)/u.test(columns) || columns.includes("var(--"));
    });

    // Asked as a set of owners rather than a count of declarations. A count said 2 and broke the moment
    // the Inbox declared its three-pane track list a second time inside a container query — which is an
    // override for a *wide* container, so stripping it the way narrow blocks are stripped would be wrong.
    // Naming the owners says what the invariant means and cannot be satisfied by a coincidence of
    // arithmetic.
    const owners = [...new Set(fixed.map((found) => selectorOwning(baseCss, found.index)))].sort();
    expect(owners, "the shell and the inbox are the fixed grids this product has").toEqual([".inbox", ".shell"]);

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

  it("lets every filter row wrap by itself, with no width to get wrong", () => {
    // Three hand-picked widths were wrong in turn. A 720px viewport rule left the row broken at 768 and
    // at 900, where the sidebar still takes 232px of the window. A container query at 820px fixed those
    // and left the settings page — seven fields, needing 1320px — broken at 1280 and at 1440. A row that
    // wraps has no width to pick, and nothing to get wrong when someone adds an eighth field.
    //
    // The analytics row then proved the point by being the eighth field: it was a flexed card whose
    // labels were given `flex: 1 1 10rem` inside a 900px block, and no assertion here could see it.
    //
    // `layout` and not `row` for two of them: the class on the `<form>` is how the form is *found*, and
    // on the settings form and the voice editors it is a flex column of groups — what lays the fields
    // out is the `.form-grid` inside each group. Asking the wrong element would have forced a stack of
    // groups to declare itself a grid of columns, which is a different thing.
    for (const entry of FILTER_ROWS) {
      const { row, field, what } = entry;
      const layout = "layout" in entry ? entry.layout : `.${row}`;

      expect(declarationsFor(layout), `${what}: the fields must wrap on their own`).toMatch(
        /grid-template-columns:\s*repeat\(auto-(?:fit|fill)/u,
      );
      expect(declarationsFor(field), `${what}: a field is one element`).toMatch(/display:\s*grid/u);

      // No breakpoint of any kind may speak for it. That is the claim, and it is the whole claim — about
      // the filter row. It used to be written as `expect(css).not.toContain("@container")`, a ban on the
      // whole file, which is a different and larger claim than the one above it: a container query is the
      // right instrument for a surface whose size really is decided by its container, and the Inbox is
      // one (Issue #112). Asked of the row itself now.
      expect(rulesAt(375), `${what}: no viewport rule may decide the layout`).not.toContain(layout);
      for (const body of balancedBodies("@container")) {
        expect(body, `${what}: no container query may decide it either`).not.toContain(layout);
      }
    }
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

  it("counts each table surface's columns from its own markup, so the numbers cannot rot", () => {
    for (const { container, source, columns } of TABLE_SURFACES) {
      expect(columnsOf(source), `${container} is drawn by ${source}`).toEqual([...columns]);
    }
  });

  it("lets every surface that renders what a person typed break a word that has nowhere to break", () => {
    // A track that can shrink still cannot wrap a token with no break opportunity in it. Without this the
    // element bursts sideways and, because `.shell-main` declares no `overflow`, takes the document with
    // it — the same failure as a grid that cannot wrap, one layer down. `white-space: nowrap` surfaces are
    // deliberately not here: they scroll inside a boundary instead, which is checked above.
    //
    // Asked of the BASE rules, which is the correction of a real defect rather than a stricter question.
    // The lead cell's wrap used to be declared inside the 900px block, and the assertion that checked it
    // asked `rulesAt(375)` — so it could only ever see the narrow side, and above 900px a pasted link
    // really did take the leads page sideways at 1024px and at 1440px. An assertion written against the
    // narrow rules cannot fail for the wide ones, however the product behaves there.
    //
    // The list is enumerated rather than spot-checked because it had rotted the other way too: the
    // comment here named three surfaces and the body asserted two, and the unasserted one — the context
    // panel, the narrowest column the product has — had no rule at all. `.conversation-name` was missing
    // for a subtler reason: it was covered by a scroll boundary rather than by a rule, so it belonged in
    // the "scrolls inside a boundary instead" exemption below — until the Inbox's two-pane stage took
    // that boundary away and a handle went under the next pane unreachably. A surface whose safety
    // depends on a boundary somewhere else is a surface waiting for that boundary to move.
    const SURFACES_CARRYING_A_PERSON_S_TEXT = [
      { selector: ".message-text", what: "a message is whatever the customer sent" },
      { selector: ".lead-table td", what: "a lead's next action is free text, and where someone pastes a link" },
      { selector: ".lead-table th", what: "the row header is the contact name, falling back to the handle" },
      { selector: ".conversation-name", what: "a row's identifier, which is a handle when there is no name" },
      { selector: ".inbox-context p", what: "the contact name, the handle, and the draft's intent" },
      { selector: ".reason-codes", what: "a cited source id is one token" },
      { selector: ".effective-voice dd", what: "a persona, a greeting or a sign-off is whatever somebody typed into the voice editor" },
      { selector: ".knowledge-name", what: "a source's title is whatever somebody typed, and one word of it can be the whole title" },
    ] as const;

    // Two remedies satisfy the rule above, and the rule is about the *outcome*: the surface contains
    // the token itself rather than leaning on a boundary somewhere else. Wrapping mid-word is one.
    // Truncating is the other, and it is the only one open to a surface that must stay one line — a
    // conversation row with a fixed height cannot let a 40-character handle wrap onto a second.
    //
    // Truncation only counts when it is complete. `text-overflow` does nothing without `overflow:
    // hidden`, and neither does anything for a grid or flex child without `min-width: 0`, which is the
    // way this is usually got wrong: the ellipsis is declared, the item refuses to shrink, and the text
    // runs under the next pane exactly as before.
    const TRUNCATES = [/overflow:\s*hidden/u, /text-overflow:\s*ellipsis/u, /white-space:\s*nowrap/u, /min-width:\s*0/u];

    for (const { selector, what } of SURFACES_CARRYING_A_PERSON_S_TEXT) {
      const declarations = declarationsFor(selector, baseCss);
      const wraps = /overflow-wrap:\s*anywhere/u.test(declarations);
      const truncates = TRUNCATES.every((property) => property.test(declarations));
      expect(
        wraps || truncates,
        `${selector}: ${what} — it must either wrap mid-word or truncate completely (overflow, text-overflow, white-space and min-width together)`,
      ).toBe(true);
    }

    // And the property is inherited, so a wrapper declaring it covers the `<strong>` and the `<span>`
    // inside it. That is why `.inbox-context p` is the entry rather than a list of its children.
    expect(css).not.toMatch(/\.inbox-context strong/u);
  });

  it("caps every auto-fit and auto-fill floor at the container, not at a width it hopes for", () => {
    // The minimum in `minmax` is a floor the track keeps even when the container is narrower, so
    // `minmax(20rem, 1fr)` draws a 320px column inside a 288px box. The style page did exactly that at
    // 320px while every wider measurement was clean — a grid that is supposed to fit, not fitting.
    // Comments are stripped: the prose above that rule quotes the broken form on purpose.
    const declarations = css.replace(/\/\*[\s\S]*?\*\//gu, "");
    // Both keywords, or a grid switched from one to the other stops having its floor checked at all —
    // which is exactly what happened the day `.form-grid` moved to `auto-fill` so a lone field would
    // stop drawing full width.
    const floors = [...declarations.matchAll(/repeat\(auto-(?:fit|fill),\s*minmax\((?<floor>.+?),\s*1fr\)\)/gu)].map(
      (found) => (found.groups?.floor ?? "").trim(),
    );

    expect(floors.length, "the auto-fit and auto-fill grids this stylesheet declares").toBeGreaterThan(0);
    // And both keywords are really present, or the alternation above is checking one of them.
    expect(declarations, "an auto-fit grid exists").toMatch(/repeat\(auto-fit,/u);
    expect(declarations, "an auto-fill grid exists").toMatch(/repeat\(auto-fill,/u);
    for (const floor of floors) {
      expect(floor, `${floor} is a floor the track keeps below the container's own width`).toMatch(
        /^min\(.+,\s*100%\)$/u,
      );
    }

    // `min-width` is the same promise made directly, and it breaks the same way: the review card leaves
    // 262px and its textarea asked for 18rem, so the form burst out of the card below a 346px viewport.
    // Either a floor is zero — the item may shrink — or it is capped at the container it lives in.
    // `[^;{]` and not `[^;]`: a declaration's value cannot contain a brace, and an at-rule *condition*
    // cannot contain a semicolon. Without that distinction this scan read `@container main (min-width:
    // 1124px) {` as a declared minimum width of `1124px) { .inbox { grid-template-columns: …` and
    // demanded that a container query's threshold be capped at 100% of a container. A query condition is
    // not a width an element is given.
    //
    // With one shape allowed to exceed, and the selector is what makes it checkable rather than a name on
    // a list here. A surface this file already *requires* to scroll absorbs a child wider than itself —
    // that is what the `scrolls` treatment above means, and the four analytics tables have always relied
    // on it. So a minimum width declared on a descendant of such a container is sound, and a minimum
    // width declared anywhere else is the defect this scan was written for. Ninety daily columns at a
    // phone's width is 1.8px a column; the chart claims six and scrolls inside the panel instead.
    const scrollBoundaries = TABLE_SURFACES.filter((surface) => surface.treatment === "scrolls").map((surface) => surface.container);
    // A trailing space, so the container's own rule is not mistaken for a rule about something inside it.
    const absorbed = (selector: string): boolean => scrollBoundaries.some((container) => selector.includes(`${container} `));

    const widths = [...declarations.matchAll(/min-width:\s*(?<floor>[^;{]+);/gu)].map((found) => ({
      floor: (found.groups?.floor ?? "").trim(),
      selector: selectorOwning(declarations, found.index ?? 0),
    }));
    expect(widths.length, "the declared minimum widths").toBeGreaterThan(0);

    const exempt = widths.filter((width) => absorbed(width.selector));
    for (const { floor, selector } of widths) {
      if (absorbed(selector)) {
        continue;
      }
      // `100%` on its own is accepted for the same reason `min(…, 100%)` is, and it is the stronger
      // case rather than a weaker one: it *is* the container's width, so it cannot exceed it by any
      // amount. The dropdown's list uses it to be at least as wide as the control it hangs from.
      expect(
        floor === "0" || floor === "100%" || /^min\(.+,\s*100%\)$/u.test(floor),
        `min-width: ${floor} on ${selector} is a width this element may not fit in`,
      ).toBe(true);
    }

    // The exemption is not allowed to be the whole answer. If every minimum width in the file became
    // exempt, this test would pass by checking nothing — and if none ever were, the branch above would be
    // dead code that silently stops working the day somebody needs it.
    expect(exempt.length, "the minimum widths inside a scroll boundary").toBeGreaterThan(0);
    expect(widths.length - exempt.length, "the minimum widths that still have to fit").toBeGreaterThan(0);
    // And it has to be able to say no: the same floor, moved out from under the boundary, is refused.
    expect(absorbed(".chart-days")).toBe(false);
    expect(exempt.every(({ selector }) => scrollBoundaries.some((container) => selector.startsWith(container)))).toBe(true);
  });

  it("gives a field whose options are sentences the whole row, and only those", () => {
    // The stylesheet states this rule itself — `.form-grid > [data-span="full"]` carries the comment
    // "anything that holds sentences, and anything that is not a field at all" — and four fields on the
    // settings form broke it. At 1024px that form's column is 744px against two tracks of about 366, and
    // the chosen value of each was truncated by 4 to 36 pixels. The truncation is deliberate and
    // documented twice next to `.select-value`; sitting in a half-width cell was not.
    //
    // Each select is attributed to the nearest field div that precedes it, which is exact here because a
    // field declares one `htmlFor` and its options follow it — and the control for that is below: all
    // eleven must resolve to *distinct* fields, so a collapsed attribution cannot pass.
    const settings = readFileSync(path.join(srcRoot, "app/workspaces/[workspaceId]/profiles/[businessProfileId]/settings/page.tsx"), "utf8");
    const catalogue = readFileSync(path.join(srcRoot, "i18n/catalogue.ts"), "utf8");
    const THRESHOLD = 40;

    // The longest label under each prefix, over both halves of the catalogue, because the worst case is
    // what has to fit and Russian is the longer of the two for every one of these.
    const longest = new Map<string, number>();
    for (const found of catalogue.matchAll(/^[ \t]*"([^"]+)":\s*"((?:[^"\\]|\\.)*)"/gmu)) {
      const key = found[1] ?? "";
      const prefix = key.slice(0, key.indexOf("."));
      longest.set(prefix, Math.max(longest.get(prefix) ?? 0, (found[2] ?? "").length));
    }

    const fields = [...settings.matchAll(/<div className="field"([^>]*)>/gu)].map((found) => ({
      at: found.index ?? 0,
      spansTheRow: (found[1] ?? "").includes('data-span="full"'),
      control: /htmlFor="([^"]+)"/u.exec(settings.slice(found.index ?? 0, (found.index ?? 0) + 400))?.[1] ?? "?",
    }));
    const selects = [...settings.matchAll(/t\.t\(`([A-Za-z]+)\.\$\{[A-Za-z]+\}`\)/gu)].map((found) => {
      const prefix = found[1] ?? "";
      const owner = fields.filter((field) => field.at < (found.index ?? 0)).at(-1);
      return {
        chars: longest.get(prefix) ?? 0,
        control: owner?.control ?? "?",
        spansTheRow: owner?.spansTheRow ?? false,
      };
    });

    expect(selects.length, "every enum-backed select on the form").toBe(11);
    expect(new Set(selects.map((select) => select.control)).size, "each attributed to its own field").toBe(11);

    const sentences = selects.filter((select) => select.chars >= THRESHOLD);
    const words = selects.filter((select) => select.chars < THRESHOLD);

    // Both kinds are present, so neither half of the rule is satisfied by finding nothing.
    expect(sentences.map((select) => select.control).toSorted()).toEqual([
      "settings-confidence",
      "settings-instagram",
      "settings-presence",
      "settings-whatsapp",
    ]);
    expect(words.length, "and the short ones the rule must leave alone").toBe(7);

    expect(
      sentences.filter((select) => !select.spansTheRow).map((select) => `${select.control} (${String(select.chars)} characters)`),
    ).toEqual([]);

    // The threshold sits in a gap rather than on a knife edge. Wedged between two adjacent measurements
    // it would make the next label somebody adds a coin toss, and this is the assertion that notices.
    const widestWord = Math.max(...words.map((select) => select.chars));
    const narrowestSentence = Math.min(...sentences.map((select) => select.chars));

    expect(narrowestSentence - widestWord, `${String(widestWord)} characters, then ${String(narrowestSentence)}`).toBeGreaterThanOrEqual(8);

    // And the stylesheet's half of the contract, so this cannot stay green while the rule it leans on is
    // renamed or removed.
    expect(declarationsFor('.form-grid > [data-span="full"]', css)).toMatch(/grid-column:\s*1\s*\/\s*-1/u);
  });

  it("gives a free-text filter a placeholder wherever the labels are hidden", () => {
    // `.inbox-search label` is visually hidden on purpose: every select in that row names what it
    // filters in its own first option — "Every channel", "Any status". A text box names nothing, so in
    // that row it has to carry a placeholder or it is an unlabelled box on screen. The Knowledge
    // library's search had none and read as a blank field between two menus; this is the rule that was
    // being applied by hand.
    expect(declarationsFor(".inbox-search label"), "this test's premise: that row hides its labels").toMatch(
      /clip-path:\s*inset\(50%\)/u,
    );

    const rows = [
      ...componentSources().matchAll(/<form[^>]*className="inbox-search"[\s\S]*?<\/form>/gu),
    ].map((found) => found[0]);
    expect(rows.length, "the rows that hide their labels").toBeGreaterThan(2);

    const bare = rows.flatMap((row) =>
      [...row.matchAll(/<input[^>]*type="(?:search|text)"[^>]*>/gu)]
        .map((found) => found[0])
        .filter((control) => !control.includes("placeholder=")),
    );

    expect(bare, "a text box in a row with hidden labels needs a placeholder").toEqual([]);
    // And there are text boxes to be wrong about, or this passes by finding none.
    expect(rows.some((row) => /<input[^>]*type="search"/u.test(row))).toBe(true);
  });

  it("keeps each label and its control one element, which is what lets the row wrap", () => {
    // CSS pairs no siblings. The old grid paired them by flowing down two rows and across, and that is
    // exactly why it could not wrap. The pairing lives in the markup now, so the markup has to hold it:
    // one stray control outside a field is a column of its own again, in every filter bar it appears in.
    const forms = filterForms();
    expect(forms.length, "the filter bars this product renders").toBeGreaterThan(0);
    expect(
      FILTER_ROWS.every(({ row }) => forms.some((form) => form.includes(`className="${row}"`))),
      "each named row must actually be found, or this loop asserts nothing about it",
    ).toBe(true);

    for (const form of forms) {
      const fields = balancedFields(form);
      // Every `<label>` in a filter row belongs to exactly one field, whichever shape the field takes:
      // in a `div.field` the label is the field's first child, and in the analytics row the label *is*
      // the field. So the two counts are equal in both, and a control that escaped its wrapper shows up
      // as a field short.
      const labels = [...form.matchAll(/<label(?=[\s>])/gu)].length;
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
