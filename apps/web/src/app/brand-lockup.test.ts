/**
 * The mark and the name keep their proportion to each other.
 *
 * The product's name is drawn in two places — the landing header and the public pages' brand link —
 * and they had drifted apart: 15px type on the landing, 19px on sign-in, and the same 30px mark beside
 * both. Against 15px type that mark stands about 2.8 times the height of the capital letters next to
 * it, so the icon reads as the brand and the name reads as a caption. That is what "the brand looks
 * small" was describing, and it is not a thing either rule looks wrong on its own.
 *
 * So both read one pair of tokens, and this holds the ratio between them. The band is deliberately
 * wide: it is not a house style, it is the range outside which a lockup stops looking like one object.
 * A change that moves the mark without the type, or the type without the mark, lands outside it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const css = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "globals.css"), "utf8");

/** A `--name: <number>px` declaration, resolved one level through `var()` if it points at another. */
function pixels(name: string): number {
  const direct = new RegExp(`--${name}:\\s*([\\d.]+)px;`, "u").exec(css);
  if (direct?.[1] !== undefined) {
    return Number(direct[1]);
  }
  const indirect = new RegExp(`--${name}:\\s*var\\(--([\\w-]+)\\);`, "u").exec(css);
  expect(indirect?.[1], `--${name} must resolve to a length`).toBeDefined();
  return pixels(indirect?.[1] ?? "");
}

/** The body of the first rule for `selector`. */
function rule(selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `${selector} must exist`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("\n}", at));
}

/** Roughly where the capitals reach in a humanist sans — enough to compare an icon against. */
const CAP_RATIO = 0.72;

describe("the brand lockup", () => {
  const text = pixels("brand-text");
  const mark = pixels("brand-mark");

  it("resolves to real numbers, so the ratio below is about something", () => {
    expect(text).toBeGreaterThan(0);
    expect(mark).toBeGreaterThan(0);
  });

  it("keeps the mark in proportion to the name", () => {
    const ratio = mark / (text * CAP_RATIO);
    // The old landing lockup was 2.78 and looked wrong; the old sign-in lockup was 2.19 and did not.
    expect(ratio, `the mark is ${ratio.toFixed(2)}× the cap height of the name`).toBeGreaterThan(1.2);
    expect(ratio, `the mark is ${ratio.toFixed(2)}× the cap height of the name`).toBeLessThan(2.2);
  });

  it("is drawn from the same two tokens everywhere it appears", () => {
    // The defect was two lockups quietly holding different numbers. A literal in either rule is that
    // coming back, whatever value it happens to hold today.
    for (const selector of [".landing-wordmark", ".auth-brand"]) {
      expect(rule(selector), `${selector} must take its size from the lockup`).toContain("font-size: var(--brand-text);");
    }
    for (const selector of [".landing-logo", ".auth-mark"]) {
      expect(rule(selector), `${selector} must take its size from the lockup`).toContain("width: var(--brand-mark);");
      expect(rule(selector)).not.toMatch(/width:\s*\d+px/u);
    }
  });

  it("sits on the product's own type scale rather than an invented size", () => {
    // `landing-page-design` is explicit that a size must resolve to a scale step, not an arbitrary
    // value. `--brand-text` points at one by name, which is what keeps that true after an edit.
    expect(css).toContain("--brand-text: var(--text-");
  });
});
