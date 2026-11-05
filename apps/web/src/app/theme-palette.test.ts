/**
 * The dark palette is declared twice, so this makes sure it is declared twice *identically*.
 *
 * Two blocks is not an accident to be cleaned up later: `@media (prefers-color-scheme: dark)` answers
 * "what does this machine prefer" and `:root[data-theme="dark"]` answers "what did this reader pick",
 * and CSS has no way to say both in one place without a build step this project does not have.
 *
 * What it does have is the obvious failure mode: somebody adds a token to one block. The page then looks
 * right in whichever theme they were testing and loses a colour in the other, which is the kind of defect
 * that reaches production because nobody opens both. Comparing the two texts catches it the moment it is
 * written, and `contrast.test.ts` keeps checking the readability of whichever values they hold.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const css = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "globals.css"), "utf8");

/** The declarations inside the block a selector opens, to its matching close brace. */
function declarationsAfter(selector: string): string {
  const at = css.indexOf(selector);
  expect(at, `${selector} must be in the stylesheet`).toBeGreaterThan(-1);
  const open = css.indexOf("{", at + selector.length - 1);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") {
      depth += 1;
    } else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        return css.slice(open + 1, i);
      }
    }
  }
  throw new Error(`${selector} is never closed`);
}

/** `--name: value` pairs, so indentation cannot make two equal blocks look different. */
function tokens(block: string): readonly string[] {
  return [...block.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map((match) => `${match[1] ?? ""}: ${(match[2] ?? "").trim()}`);
}

describe("the dark palette", () => {
  const fromQuery = tokens(declarationsAfter(':root:not([data-theme="light"])'));
  const fromChoice = tokens(declarationsAfter(':root[data-theme="dark"]'));

  it("is not an empty comparison", () => {
    // Two empty extractions are equal, and would report agreement between blocks that do not exist. The
    // count is asserted first so every claim below is about something.
    expect(fromQuery.length).toBeGreaterThan(12);
    expect(fromQuery).toContain("surface: #14171b");
    expect(fromQuery).toContain("text: #eef1f5");
  });

  it("says the same thing whether the machine preferred it or the reader chose it", () => {
    expect(fromChoice).toEqual(fromQuery);
  });

  it("lets an explicit light choice win over a machine that prefers dark", () => {
    // Without the `:not()`, a reader on a dark laptop could never get the light page: the query would
    // keep overriding `:root`, and the control would do nothing at all for them.
    expect(css).toContain('@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {');
  });

  it("shows which half of the appearance control is live before any script runs", () => {
    // The server marks neither option when nobody has chosen, because it cannot read the machine's
    // preference — so the stylesheet has to answer, or the control arrives blank and fills in late.
    // Light is live by default; the query hands that over to dark on a machine that prefers dark.
    expect(css).toContain('.switch[data-following-system] .switch-option[data-public-theme="light"] {');
    expect(css).toContain('.switch[data-following-system] .switch-option[data-public-theme="dark"] {');

    const query = css.indexOf('.switch[data-following-system] .switch-option[data-public-theme="dark"]');
    const governing = css.lastIndexOf("@media (prefers-color-scheme: dark)", query);
    expect(governing, "the dark half must be inside a colour-scheme query, not unconditional").toBeGreaterThan(-1);
    // And inside that query the light half must be handed back, or both would look live at once.
    expect(css.slice(governing, query)).toContain('data-public-theme="light"');
  });

  it("declares the chosen palette after the query, where it can win", () => {
    // Source order decides between two equal-specificity rules, and `contrast.test.ts` reads everything
    // before the query as the light theme — so this block being above it would both lose and pollute.
    expect(css.indexOf(':root[data-theme="dark"]')).toBeGreaterThan(css.indexOf("@media (prefers-color-scheme: dark)"));
  });
});
