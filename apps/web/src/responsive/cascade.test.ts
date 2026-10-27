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
    expect(token("--text-s")).toBe("13px");
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
