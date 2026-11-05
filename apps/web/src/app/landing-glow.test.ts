/**
 * The hero's glow has to run out of brightness before it runs out of band.
 *
 * The band clips (`overflow: hidden`), so this is not a question of taste: any part of the gradient that
 * is still visible where the band ends gets cut with a hard vertical line, and a soft glow ending in a
 * straight edge reads as a rendering fault rather than as decoration. It was one — measured at #192131
 * against a #10141b band at x=0 on a 1000px window, a bright wedge sliced square into the top-left
 * corner, and it got worse the narrower the window because the gradient's centre sat at 30%.
 *
 * The property that fixes it is arithmetic, so the test is arithmetic: read the declaration, work out
 * where the last visible ring falls, and require it to stay inside the box. Percentages make that
 * viewport-independent — if it holds, it holds at every width, which is more than measuring three
 * screenshots could promise.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const css = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "globals.css"), "utf8");

function glowRule(): string {
  const at = css.indexOf(".landing-glow {");
  expect(at, "the glow must be in the stylesheet").toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("\n}", at));
}

describe("the hero glow", () => {
  const rule = glowRule();

  const gradient = /radial-gradient\(\s*(?<rx>[\d.]+)%\s+(?<ry>[\d.]+)%\s+at\s+(?<cx>[\d.]+)%\s+(?<cy>[\d.]+)%/u.exec(rule);
  const lastStop = /transparent\s+(?<stop>[\d.]+)%\s*\)/u.exec(rule);
  const inset = /inset:\s*(?<value>[^;]+);/u.exec(rule);

  it("is readable as numbers at all", () => {
    // Every assertion below is `undefined < something` if the parse quietly failed, which passes.
    expect(gradient?.groups, "the gradient must state a radius and a centre in percentages").toBeDefined();
    expect(lastStop?.groups, "the gradient must end at a transparent stop").toBeDefined();
    expect(inset?.groups, "the glow must state its inset").toBeDefined();
  });

  it("fades out before either edge of the band", () => {
    const radius = Number(gradient?.groups?.["rx"]);
    const centre = Number(gradient?.groups?.["cx"]);
    const stop = Number(lastStop?.groups?.["stop"]) / 100;

    // The outermost ring that still carries colour, as a share of the element's width.
    const reach = radius * stop;
    expect(centre - reach, "the glow reaches past the left edge and will be cut square").toBeGreaterThan(0);
    expect(centre + reach, "the glow reaches past the right edge and will be cut square").toBeLessThan(100);
  });

  it("does not hang off the sides of the box that clips it", () => {
    // The old value was `-40% -10% auto -10%`: the element started off-screen, so the clip was certain
    // however gentle the gradient. The inline sides must not be negative.
    const [, right = "0", , left = right] = (inset?.groups?.["value"] ?? "").trim().split(/\s+/);
    expect(Number.parseFloat(right.replace("%", "")), "right inset must not be negative").toBeGreaterThanOrEqual(0);
    expect(Number.parseFloat(left.replace("%", "")), "left inset must not be negative").toBeGreaterThanOrEqual(0);
  });
});
