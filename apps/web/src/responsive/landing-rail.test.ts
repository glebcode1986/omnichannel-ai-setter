/**
 * Everything on the landing page stands on one rail (measured 2026-11-05 on dev).
 *
 * `.landing-band > *` gives every band child `max-width` and `margin-inline: auto`, and two rules had
 * quietly opted out of it:
 *
 * - `.landing-steps` set `max-width: none` inside `@media (min-width: 900px)` while adding its second
 *   column, so the list lost the rail. On a 1920 screen its heading began at x=340 and the list it heads
 *   began at x=24 and ran 316px past the heading's right edge.
 * - `.landing-actions` sets `margin: 0 0 …`, and the shorthand resets the inline axis to zero. The
 *   closing band's button sat 316px left of the centred words above it; `justify-content: center` could
 *   not help, because it centres the button inside a box that is itself pinned left.
 *
 * Both were invisible below 1288px — the rail is not binding until the band is wider than it — and both
 * grew as `(viewport − 1288) ÷ 2`: 0 at 1288, 16px at 1320, 76px at 1440, 316px at 1920. That is why a
 * laptop never showed them, and why this file states the width at which a check would have to look.
 *
 * Read from the source rather than resolved in jsdom, deliberately: jsdom applies no `@media` block at
 * all, so the one rule that caused half of this would be invisible to a computed-style test. The
 * measurements above were taken in a real browser.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const css = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../app/globals.css"),
  "utf8",
);

/** The body of the first rule for `selector`, from its brace to the matching close. */
function rule(selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `${selector} must be in the stylesheet`).toBeGreaterThan(-1);
  const open = at + selector.length + 1;
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

/** The text inside `@media (min-width: 900px)`, where the two-column steps live. */
function wideBlock(): string {
  const at = css.indexOf("@media (min-width: 900px) {");
  expect(at, "the two-column breakpoint must exist").toBeGreaterThan(-1);
  let depth = 0;
  for (let i = css.indexOf("{", at); i < css.length; i += 1) {
    if (css[i] === "{") {
      depth += 1;
    } else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        return css.slice(at, i + 1);
      }
    }
  }
  throw new Error("the breakpoint is never closed");
}

describe("the landing page's rail", () => {
  it("is one named value, not a literal repeated", () => {
    // Two literals are two things that can disagree, and these two did.
    expect(css).toContain("--landing-rail: 1240px;");
    expect(rule(".landing-band > *")).toContain("max-width: var(--landing-rail);");
    expect(rule(".landing-band > *")).toContain("margin-inline: auto;");
  });

  it("survives the step list going to two columns", () => {
    const wide = wideBlock();
    expect(wide, "the breakpoint must be the one that lays the steps out in two columns").toContain(".landing-steps");
    expect(wide).toContain("max-width: var(--landing-rail);");
    expect(wide, "`max-width: none` here is what took the steps off the rail").not.toContain("max-width: none");
  });

  it("centres the closing call to action, box and all", () => {
    const closing = rule(".landing-closing .landing-actions");
    expect(closing, "centring the button inside the box is not centring the box").toContain("margin-inline: auto;");
    // And the rule that resets it is still the one being corrected, so this stays necessary.
    expect(rule(".landing-actions")).toContain("margin: 0 0 var(--space-4);");
  });
});
