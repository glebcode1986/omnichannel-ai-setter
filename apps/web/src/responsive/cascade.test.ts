// @vitest-environment jsdom
/**
 * What the stylesheet actually resolves to, not what it declares (Issue #111 item 1).
 *
 * Every other test in this directory is a string search over `globals.css`, and a string search cannot see
 * the one thing that went wrong here: a rule was added *above* an existing rule with the identical
 * selector, so four of its five declarations never applied. The search found the new rule and reported it
 * present. The cards rendered with the old values.
 *
 * jsdom lays nothing out, but it does resolve the cascade — specificity and source order — which is
 * exactly the question. It does **not** resolve `var()`, so `getComputedStyle` hands back the winning
 * *declaration* rather than a pixel value. That is a limit worth stating plainly, and for this purpose it
 * is not a weakness: the question is which rule won, and the declaration names it. The token values are
 * asserted separately, against `:root`, so a renamed or re-valued token cannot pass unnoticed either.
 *
 * What this file does not prove: that anything is the right *size* on a real screen. Nothing in this
 * repository can prove that, and the branch's own measurements were taken in a browser by hand.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(path.join(srcRoot, "app/globals.css"), "utf8");

/** The stylesheet, loaded the way the app loads it, with the markup a route really renders. */
function mount(markup: string): void {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
  document.body.innerHTML = markup;
}

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

/** The value of a custom property as `:root` declares it. */
function token(name: string): string {
  const found = new RegExp(`^\\s*${name}:\\s*(?<value>[^;]+);`, "mu").exec(css);
  expect(found?.groups?.value, `${name} must be declared`).toBeDefined();
  return (found?.groups?.value ?? "").trim();
}

describe("a chart inside a panel", () => {
  beforeEach(() => {
    // A bar list and a day row, in the panel they are always rendered in. The panel is what makes this
    // worth resolving rather than grepping: `.metric-panel dl` styles every definition list inside it,
    // and `.bar-rows` is one.
    mount(`
      <section class="metric-panel" data-panel="drafts">
        <dl class="bar-rows" id="bars" data-chart="bars" data-scale="whole">
          <div class="bar-row" id="row" data-row="autoSent">
            <dt id="label">Sent unattended</dt>
            <dd class="bar-value" id="value">4</dd>
            <dd class="bar-plot" id="plot" aria-hidden="true">
              <span class="bar-track" id="track"><span class="bar-fill" id="fill" style="--bar: 40.00%"></span></span>
            </dd>
          </div>
        </dl>
        <figure class="chart" data-chart="days">
          <ol class="chart-days" id="days" style="--day-count: 7">
            <li id="slot"><span class="chart-column" id="column" style="--column: 60.00%"></span></li>
          </ol>
        </figure>
      </section>
    `);
  });

  const resolved = (id: string, property: string): string =>
    getComputedStyle(document.getElementById(id) as HTMLElement).getPropertyValue(property);

  it("lets the bar list lay itself out, rather than inheriting the panel's two columns", () => {
    // `.metric-panel dl` declares `grid-template-columns: 1fr auto`, and it is a class plus a type — so it
    // beats a bare `.bar-rows` whichever order the two are written in, and the label, the number and the
    // bar would be dealt into alternating columns. The rule has to name the panel too, and this is the
    // assertion that fails if somebody "tidies" it back to `.bar-rows`.
    expect(resolved("bars", "grid-template-columns")).toBe("none");
    expect(resolved("bars", "display")).toBe("grid");
  });

  it("places the label and its number on one line, with the bar across both", () => {
    expect(resolved("label", "grid-area")).toContain("1 / 1");
    expect(resolved("value", "grid-area")).toContain("1 / 2");
    expect(resolved("plot", "grid-area")).toContain("2 / 1");
  });

  it("keeps the two-pixel floor on a mark, where the data cannot overrule it", () => {
    // The component sets `--bar` and `--column`, never a width or a height: an inline length would win
    // over these rules and the smallest rows would round to nothing. jsdom does not substitute `var()`,
    // which is the point — the declaration that won is what names the floor.
    expect(resolved("fill", "width")).toBe("max(2px, var(--bar))");
    expect(resolved("column", "height")).toBe("max(2px, var(--column))");
  });

  it("gives the day row its minimum width only because it is inside a scroll boundary", () => {
    expect(resolved("days", "min-width")).toBe("calc(var(--day-count) * 6px)");
    // And the boundary is really declared, which is the condition the width depends on.
    expect(resolved("bars", "display"), "the panel exists in this mount").toBe("grid");
    expect(getComputedStyle(document.querySelector(".metric-panel") as HTMLElement).overflowX).toBe("auto");
  });

  it("draws the two series as two steps of one grey, not as two hues", () => {
    // `background`, not `background-color`: the declaration is a shorthand holding a `var()`, and jsdom
    // cannot decompose that — it reports the longhand as its initial transparent, which is not what any
    // browser paints. The shorthand names the rule that won, which is the question being asked.
    document.body.innerHTML = `
      <section class="metric-panel">
        <span class="chart-column" id="outer"></span>
        <span class="chart-column" id="inner" data-series="secondary"></span>
        <span class="bar-fill" id="mark"></span>
        <span class="bar-track" id="rail"></span>
      </section>
    `;
    expect(resolved("outer", "background")).toBe("var(--border-strong)");
    expect(resolved("inner", "background")).toBe("var(--accent)");
    expect(resolved("mark", "background")).toBe("var(--accent)");
    // The unfilled part of a bar is a lighter step of the same neutral, never a second colour.
    expect(resolved("rail", "background")).toBe("var(--surface-selected)");

    // Every one of them carries no hue, which is the house rule this chart had to work within: colour is
    // spent on the brand mark and on a state somebody must notice, and nowhere else. A chart that
    // introduced two hues of its own would be the loudest thing in the product.
    for (const name of ["--border-strong", "--accent", "--surface-selected"]) {
      const hex = token(name);
      expect(hex, `${name} must be a plain hex to read channels from`).toMatch(/^#[0-9a-f]{6}$/iu);
      const [red, green, blue] = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
      expect([green, blue], `${name} must carry no hue`).toEqual([red, red]);
    }
  });
});

describe("the cascade, as a browser resolves it", () => {
  beforeEach(() => {
    // The board's real shape: a column, its heading, its list, and one card with a secondary line.
    mount(`
      <div class="lead-board">
        <section class="lead-column" data-stage="NEW">
          <h3 id="heading">NEW · 1</h3>
          <ul id="list">
            <li id="card"><a data-open-lead="true">Ann</a><p class="muted" id="line">instagram · nobody</p></li>
          </ul>
        </section>
      </div>
    `);
  });

  it("gives a lead card the padding, gap and radius its own rule declares", () => {
    const card = getComputedStyle(document.getElementById("card") as HTMLElement);

    // These four were the defect: a second `.lead-column li` block 45 lines below won all of them, so the
    // card drew at 8px padding, 4px gap and a 10px radius while the rule above it asked for the card
    // treatment. Asserted as the declarations that win, because jsdom does not resolve `var()`.
    expect({ padding: card.padding, gap: card.gap, radius: card.borderRadius, background: card.background }).toEqual({
      padding: "var(--space-3)",
      gap: "var(--space-2)",
      radius: "var(--radius-sm)",
      background: "var(--surface-raised)",
    });

    // And the tokens those names resolve to, so the pair cannot drift apart silently.
    expect({ space3: token("--space-3"), space2: token("--space-2"), radiusSm: token("--radius-sm") }).toEqual({
      space3: "12px",
      space2: "8px",
      radiusSm: "6px",
    });
  });

  it("raises the card off the column it sits in, which is what dark mode made visible", () => {
    // In light mode `--surface` and `--surface-raised` are the same white, so the lost lift was invisible
    // there; in dark mode the card resolved to exactly its column's background. The point of the card is
    // that it is a thing you can pick up, so the two must not be the same token.
    const card = getComputedStyle(document.getElementById("card") as HTMLElement);
    const column = getComputedStyle(document.querySelector(".lead-column") as HTMLElement);

    expect(card.background).toBe("var(--surface-raised)");
    expect(column.background).toBe("var(--surface)");

    const dark = /@media \(prefers-color-scheme: dark\)[\s\S]*?\n\}/u.exec(css)?.[0] ?? "";
    const surface = /--surface:\s*(?<value>[^;]+);/u.exec(dark)?.groups?.value?.trim();
    const raised = /--surface-raised:\s*(?<value>[^;]+);/u.exec(dark)?.groups?.value?.trim();
    expect(surface, "the dark block must set both").toBeDefined();
    expect(raised).toBeDefined();
    expect(raised, "a raised card has to be a different colour from the column in dark mode").not.toBe(surface);
  });

  it("sizes the column heading and the card's secondary lines from the type scale", () => {
    const heading = getComputedStyle(document.getElementById("heading") as HTMLElement);
    const line = getComputedStyle(document.getElementById("line") as HTMLElement);

    // The heading's `margin: 0` lost to a `margin: 0 0 8px` in the same position. The card's lines were a
    // separate case of the same shape, by specificity rather than order: `.lead-column li > p` (0,1,2)
    // could never beat `.lead-column .muted` (0,2,0), so the rule that named the token was inert and a
    // literal decided the size. One rule now, on the token.
    expect({ margin: heading.margin, size: heading.fontSize }).toEqual({ margin: "0px", size: "var(--text-s)" });
    expect(line.fontSize).toBe("var(--text-s)");
    // 12px, not 13: the scale was snapped onto the grid our own `landing-page-design` requires, where
    // the step below 13 is 12. The screen had been rendering six sizes, none of them a scale step.
    expect(token("--text-s")).toBe("12px");
  });

  it("gives the list the gap its rule declares", () => {
    expect(getComputedStyle(document.getElementById("list") as HTMLElement).gap).toBe("var(--space-3)");
  });

  it("would notice the defect coming back", () => {
    // Otherwise every assertion above passes because jsdom ignores the stylesheet rather than because the
    // cascade is right. The same markup, with the shape of the bug appended: a later identical selector.
    document.head.innerHTML = "";
    const style = document.createElement("style");
    style.textContent = `${css}\n.lead-column li { padding: 8px; gap: 4px; }`;
    document.head.appendChild(style);

    const card = getComputedStyle(document.getElementById("card") as HTMLElement);
    expect({ padding: card.padding, gap: card.gap }).toEqual({ padding: "8px", gap: "4px" });
  });
});

describe("a figure that is not a figure", () => {
  beforeEach(() => {
    // Two tiles of the analytics dashboard: one that has a number, and one that does not. `Measured`
    // renders the absent case as `.muted` inside the same paragraph as the number.
    mount(`
      <div class="metric-tiles">
        <section class="metric-tile" data-panel="takeover">
          <h2 id="label">Human takeover</h2>
          <p class="metric-figure" id="figure">25%</p>
          <p class="muted" id="caption">2 of 8 conversations</p>
        </section>
        <section class="metric-tile" data-panel="missing-facts">
          <p class="metric-figure" id="absent"><span class="muted" id="words">Not measured</span></p>
        </section>
      </div>
    `);
  });

  it("sets a measurement at the display step", () => {
    const figure = getComputedStyle(document.getElementById("figure") as HTMLElement);
    expect({ size: figure.fontSize, weight: figure.fontWeight }).toEqual({
      size: "var(--text-xl)",
      weight: "var(--weight-semibold)",
    });
    expect(token("--text-xl")).toBe("24px");
  });

  it("does not set the words that stand in for one that way", () => {
    // The defect: "Not measured" arrived at 24px and semibold, inside a paragraph styled for a number.
    // On a quiet week the page's four largest, heaviest lines were four announcements of having nothing
    // to say — on a dashboard whose whole claim is that it never overstates what it knows.
    const words = getComputedStyle(document.getElementById("words") as HTMLElement);
    expect({ size: words.fontSize, weight: words.fontWeight }).toEqual({
      size: "var(--text-m)",
      weight: "var(--weight-regular)",
    });
  });

  it("would notice either half being lost, since both depend on source order", () => {
    // `.metric-figure .muted` (0,2,0) beats `.metric-figure` (0,1,0) by specificity, so this pair cannot
    // break the way the lead card's did. It can still be deleted, and then the assertion above would be
    // passing on jsdom's default rather than on a rule — so the control re-plants the defect.
    document.head.innerHTML = "";
    const style = document.createElement("style");
    style.textContent = `${css}\n.metric-figure .muted { font-size: var(--text-xl); font-weight: var(--weight-semibold); }`;
    document.head.appendChild(style);

    const words = getComputedStyle(document.getElementById("words") as HTMLElement);
    expect({ size: words.fontSize, weight: words.fontWeight }).toEqual({
      size: "var(--text-xl)",
      weight: "var(--weight-semibold)",
    });
  });

  it("gives a tile's label the smallest step, so the number is the thing read first", () => {
    const label = getComputedStyle(document.getElementById("label") as HTMLElement);
    expect({ size: label.fontSize, weight: label.fontWeight }).toEqual({
      size: "var(--text-s)",
      weight: "var(--weight-medium)",
    });
  });
});

describe("no rule is shadowed by a twin", () => {
  /**
   * Every top-level block's selector, with the properties it declares and the line it starts on.
   *
   * Comments are stripped first, and that is not cosmetic: a block's selector is the text between the
   * previous `}` and its own `{`, so a doc comment above a rule lands inside that text and the selector
   * never matches its twin. The duplicate that shipped was invisible to a scan that skipped this step.
   */
  function topLevelBlocks(): readonly { readonly selector: string; readonly properties: readonly string[]; readonly line: number }[] {
    const lineOf: number[] = [];
    let stripped = "";
    let line = 1;
    for (let at = 0; at < css.length; ) {
      if (css.startsWith("/*", at)) {
        const end = css.indexOf("*/", at + 2);
        const stop = end === -1 ? css.length : end + 2;
        line += [...css.slice(at, stop)].filter((character) => character === "\n").length;
        at = stop;
        continue;
      }
      stripped += css[at];
      lineOf.push(line);
      if (css[at] === "\n") {
        line += 1;
      }
      at += 1;
    }

    const blocks: { selector: string; properties: string[]; line: number }[] = [];
    let depth = 0;
    let from = 0;
    let open = 0;
    for (let at = 0; at < stripped.length; at += 1) {
      if (stripped[at] === "{") {
        if (depth === 0) {
          blocks.push({ selector: stripped.slice(from, at).trim().split(/\s+/u).join(" "), properties: [], line: lineOf[at] ?? 0 });
          open = at;
        }
        depth += 1;
      } else if (stripped[at] === "}") {
        depth -= 1;
        if (depth === 0) {
          const body = stripped.slice(open + 1, at);
          const current = blocks.at(-1);
          if (current !== undefined) {
            current.properties = [...body.matchAll(/(?:^|;)\s*(?<name>[a-z-]+)\s*:/gu)].map((found) => found.groups?.name ?? "");
          }
          from = at + 1;
        }
      }
    }
    return blocks;
  }

  it("declares no property twice for the same top-level selector", () => {
    // Two blocks with one selector are only a problem when they declare the same property: the later wins
    // and the earlier reads as though it applies. Splitting a selector's declarations across two blocks is
    // untidy and harmless, and three such pairs exist here on purpose, so the test asks the narrow
    // question rather than the tidy one.
    const byProperty = new Map<string, number[]>();
    for (const block of topLevelBlocks()) {
      if (block.selector.startsWith("@") || block.selector === ":root" || block.selector === "*") {
        continue;
      }
      for (const property of block.properties) {
        const key = `${block.selector} { ${property} }`;
        byProperty.set(key, [...(byProperty.get(key) ?? []), block.line]);
      }
    }

    const shadowed = [...byProperty.entries()]
      .filter(([, lines]) => lines.length > 1)
      .map(([key, lines]) => `${key} declared at lines ${lines.join(" and ")}`);

    expect(shadowed, "the later declaration silently wins and the earlier one is dead").toEqual([]);
  });

  it("reads the whole stylesheet, and would see a planted twin", () => {
    const blocks = topLevelBlocks();
    expect(blocks.length, "the stylesheet's top-level blocks").toBeGreaterThan(150);
    expect(blocks.map((block) => block.selector)).toContain(".lead-column li");
    expect(blocks.filter((block) => block.selector === ".lead-column li")).toHaveLength(1);

    // The line numbers must be real, or a failure message points nowhere.
    const card = blocks.find((block) => block.selector === ".lead-column li");
    expect(css.split("\n")[(card?.line ?? 1) - 1]).toContain(".lead-column li");
  });
});
