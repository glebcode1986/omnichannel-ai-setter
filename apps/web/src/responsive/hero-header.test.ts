/**
 * The hero's header leaves room for the character standing on the demonstration.
 *
 * Measured on dev at 1440: the controls occupied 1147–1340 × 100–144 and the character 1221–1317 ×
 * 103–199, so it rose 41px into them and sat across the appearance control and the language select.
 * Neither element was wrong on its own — the character had overhung the demonstration since it was
 * drawn, and the corner was empty until the controls moved into it.
 *
 * The fix is not a gap that happened to work at 1440. The character's height and how much of it is
 * tucked behind the panel are tokens, and the header's clearance is computed from them, so changing
 * the character moves the header rather than quietly putting it back underneath. This file holds that
 * relation, because it is the kind that survives review and dies to the next convenient round number.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const css = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../app/globals.css"), "utf8");

describe("the hero header and the character below it", () => {
  it("states the character's size once, as tokens", () => {
    expect(css).toContain("--keeper-size: 96px;");
    expect(css).toContain("--keeper-sink: 22px;");
    // And the character reads them rather than repeating the numbers.
    const keeper = css.slice(css.indexOf(".keeper {"), css.indexOf("\n}", css.indexOf(".keeper {")));
    expect(keeper).toContain("width: var(--keeper-size);");
    expect(keeper).toContain("margin-bottom: calc(-1 * var(--keeper-sink));");
    expect(keeper, "a literal here is the disagreement coming back").not.toMatch(/width:\s*96px/u);
  });

  it("clears the character by computing the gap from those tokens", () => {
    expect(css).toContain("padding-bottom: calc(var(--keeper-size) - var(--keeper-sink) + var(--space-3));");
  });

  it("only reserves that room where the character can reach the header", () => {
    // Below 1000px the hero is one column and the demonstration sits under the text, so the character
    // rises into the middle of the page. Reserving the gap there would be blank space for nothing.
    //
    // Every `.landing-topbar` rule is read rather than the first one: the scoped copy is written beside
    // the breakpoint it belongs to, which puts it *earlier* in the file than the base rule, and an
    // `indexOf` for the base rule finds the scoped one instead. That is how this test first passed the
    // wrong claim.
    const rules = [...css.matchAll(/\.landing-topbar \{/gu)].map((match) => {
      const at = match.index ?? 0;
      const body = css.slice(at, css.indexOf("}", at));
      const query = css.lastIndexOf("@media", at);
      const closed = css.lastIndexOf("\n}", at);
      return { body, insideWideQuery: query > closed && css.startsWith("@media (min-width: 1000px)", query) };
    });

    expect(rules.length, "there should be a base rule and one scoped copy").toBe(2);
    const reserving = rules.filter((rule) => rule.body.includes("--keeper-size"));
    expect(reserving.length, "exactly one rule reserves the room").toBe(1);
    expect(reserving[0]?.insideWideQuery, "and it is the one inside the two-column breakpoint").toBe(true);
  });
});
