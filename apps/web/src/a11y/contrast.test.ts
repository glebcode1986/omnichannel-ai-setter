/**
 * Colour contrast, computed from the tokens rather than eyeballed (Issue #35).
 *
 * The issue asks for "common contrast/semantic failures". Contrast is the one accessibility property that
 * cannot be checked by looking at the markup and cannot be measured in jsdom either — there is no layout
 * and no paint, so a browser-based checker run here would report nothing and pass.
 *
 * What *can* be done, and is stronger: every colour in this product comes from a custom property on
 * `:root`, and the pairs those properties are used in are a short, knowable list. So this reads the real
 * stylesheet, extracts both themes' tokens, and computes the WCAG 2.1 ratio for each pair the product
 * actually renders. A token edited to a prettier shade fails the build with the number it produced.
 *
 * Limitations, stated rather than implied: this checks the token pairs listed below, in the two themes the
 * stylesheet defines. It cannot catch a component that invents a colour inline (a separate test forbids
 * that), and it cannot judge a colour over an image or a gradient, of which this product has none.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../app/globals.css"), "utf8");

/** The tokens declared in one `:root` block. */
function tokensIn(block: string): Readonly<Record<string, string>> {
  const tokens: Record<string, string> = {};
  for (const match of block.matchAll(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    tokens[match[1] ?? ""] = match[2] ?? "";
  }
  return tokens;
}

/** The light theme is the bare `:root`; the dark one is the `:root` inside the colour-scheme query. */
function themes(): Readonly<Record<"light" | "dark", Readonly<Record<string, string>>>> {
  const darkStart = stylesheet.indexOf("@media (prefers-color-scheme: dark)");
  expect(darkStart, "the stylesheet must define a dark theme").toBeGreaterThan(-1);
  const darkEnd = stylesheet.indexOf("\n}", stylesheet.indexOf("}", darkStart));
  return {
    light: tokensIn(stylesheet.slice(0, darkStart)),
    dark: tokensIn(stylesheet.slice(darkStart, darkEnd)),
  };
}

function channel(value: number): number {
  const srgb = value / 255;
  // The WCAG transfer function, not a gamma approximation: the two disagree enough near the threshold to
  // pass a pair that should fail.
  return srgb <= 0.040_45 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const full = hex.length === 4 ? `#${[...hex.slice(1)].map((digit) => digit.repeat(2)).join("")}` : hex;
  const [red, green, blue] = [1, 3, 5].map((offset) => Number.parseInt(full.slice(offset, offset + 2), 16));
  return 0.2126 * channel(red ?? 0) + 0.7152 * channel(green ?? 0) + 0.0722 * channel(blue ?? 0);
}

export function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
}

/**
 * The pairs the product renders, and the level each must reach.
 *
 * 4.5 for body text and 3.0 for large text and for non-text boundaries, which is what WCGA 2.1 AA asks.
 * Every pair here corresponds to a rule in the stylesheet; a pair nobody renders is not listed, because a
 * requirement nothing has to satisfy is one somebody will eventually satisfy by deleting the test.
 */
const PAIRS: readonly { readonly foreground: string; readonly background: string; readonly minimum: number; readonly why: string }[] = [
  { foreground: "text", background: "surface", minimum: 4.5, why: "body text on a panel" },
  { foreground: "text", background: "surface-sunken", minimum: 4.5, why: "body text on the page behind the panels" },
  { foreground: "text", background: "surface-raised", minimum: 4.5, why: "body text on a raised card" },
  { foreground: "text-muted", background: "surface", minimum: 4.5, why: "hints and secondary lines, which are still prose" },
  { foreground: "text-muted", background: "surface-sunken", minimum: 4.5, why: "hints on the page background" },
  { foreground: "accent", background: "surface", minimum: 4.5, why: "links, which are text" },
  { foreground: "accent-contrast", background: "accent", minimum: 4.5, why: "the label on a primary button" },
  { foreground: "ok", background: "surface", minimum: 4.5, why: "a success state, read as text" },
  { foreground: "warn", background: "surface", minimum: 4.5, why: "a warning, read as text" },
  { foreground: "stop", background: "surface", minimum: 4.5, why: "a refusal, which is the one somebody must not miss" },
  { foreground: "border-strong", background: "surface", minimum: 3, why: "a control's own boundary" },
  // The binding one for `.button`, which sits on a raised surface rather than on the panel. Checking
  // only against `--surface` would pass a button whose actual background is lighter.
  { foreground: "border-strong", background: "surface-raised", minimum: 3, why: "a button's edge, on the surface a button actually has" },
  { foreground: "accent", background: "surface-sunken", minimum: 3, why: "the focus ring against the page" },
];

describe("colour contrast", () => {
  it("declares both themes as tokens, so this test has something to check", () => {
    const { light, dark } = themes();

    // If the tokens stopped being tokens, every assertion below would pass by finding nothing.
    for (const theme of [light, dark]) {
      expect(Object.keys(theme).length).toBeGreaterThan(8);
      for (const name of ["text", "text-muted", "surface", "accent", "accent-contrast", "ok", "warn", "stop"]) {
        expect(theme, `both themes must define --${name}`).toHaveProperty(name);
      }
    }
    // And the two must actually differ, or "dark mode" is a comment.
    expect(light["surface"]).not.toBe(dark["surface"]);
  });

  it.each(["light", "dark"] as const)("meets WCAG AA in the %s theme", (name) => {
    const theme = themes()[name];
    const failures: string[] = [];

    for (const pair of PAIRS) {
      const foreground = theme[pair.foreground];
      const background = theme[pair.background];
      expect(foreground, `--${pair.foreground} is missing`).toBeDefined();
      expect(background, `--${pair.background} is missing`).toBeDefined();
      const ratio = contrastRatio(foreground ?? "#000", background ?? "#fff");
      if (ratio < pair.minimum) {
        // The number it produced, so whoever changed the token can see how far off it is rather than
        // guessing which shade to try next.
        failures.push(`--${pair.foreground} on --${pair.background} is ${ratio.toFixed(2)}:1, needs ${pair.minimum.toFixed(1)}:1 (${pair.why})`);
      }
    }

    expect(failures).toEqual([]);
  });

  it("computes the ratio the way WCAG does", () => {
    // The arithmetic itself, against values with known answers. Without this the checks above could pass
    // because the formula is wrong in a direction that flatters everything.
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 2);
    // Order must not matter: contrast is a property of the pair.
    expect(contrastRatio("#595959", "#ffffff")).toBeCloseTo(contrastRatio("#ffffff", "#595959"), 5);
    // A known AA boundary: #767676 on white is the classic 4.54:1.
    expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThan(4.5);
    expect(contrastRatio("#777777", "#ffffff")).toBeLessThan(4.5);
    // Three-digit hex is the same colour as its expansion.
    expect(relativeLuminance("#fff")).toBeCloseTo(relativeLuminance("#ffffff"), 6);
  });

  it("would fail a token somebody lightened for looks", () => {
    // Otherwise a green suite means only that the matcher is broken.
    expect(contrastRatio("#9aa3ad", "#ffffff")).toBeLessThan(4.5);
  });
});
