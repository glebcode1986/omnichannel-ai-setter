/**
 * In-page navigation moves, and stops moving for anyone who asked it to.
 *
 * The landing page's second button is an anchor to `#how`, and it teleported: the reader arrived with no
 * sense of whether the target was above or below them, which is the one thing the scroll was there to
 * say.
 *
 * The reduced-motion half needs its own assertion rather than relying on the blanket rule already in the
 * stylesheet. That rule zeroes `animation-duration` and `transition-duration` on `*`, and a smooth scroll
 * is neither an animation nor a transition — so the sweeping rule that looks like it covers everything
 * covers everything except this.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const css = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "globals.css"), "utf8");

/** The text of the `prefers-reduced-motion: reduce` block, braces matched. */
function reducedMotionBlock(): string {
  const at = css.indexOf("@media (prefers-reduced-motion: reduce)");
  expect(at, "the stylesheet must answer reduced motion").toBeGreaterThan(-1);
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
  throw new Error("the reduced-motion block is never closed");
}

describe("moving between places on a page", () => {
  it("glides rather than jumping", () => {
    expect(css).toContain("scroll-behavior: smooth;");
    // And the target does not arrive jammed against the top edge.
    expect(css).toContain("scroll-margin-top:");
  });

  it("stops gliding for a reader who prefers reduced motion", () => {
    const block = reducedMotionBlock();
    expect(block.length, "an empty block would satisfy every check below").toBeGreaterThan(80);
    expect(block, "the blanket duration rule does not reach scroll-behavior").toContain("scroll-behavior: auto;");
  });

  it("still relies on the blanket rule for everything that is a duration", () => {
    // Stated so that removing the blanket rule fails here rather than quietly halving this guarantee.
    const block = reducedMotionBlock();
    expect(block).toContain("animation-duration: 0.01ms !important;");
    expect(block).toContain("transition-duration: 0.01ms !important;");
  });
});
