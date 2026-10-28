/**
 * How wide the Inbox's reading thread actually ends up (Issue #112).
 *
 * **Why this file is arithmetic and not a string search.** The thread collapsed to 26px at a 901px window
 * and the suite was green, because every check in `breakpoints.test.ts` asks whether a rule *exists*. The
 * rule existed. What was wrong was the number it produced, and the number is not in the stylesheet — it
 * comes out of the grid track sizing algorithm, which is why nobody read it off the file.
 *
 * So this resolves the tracks the way a browser does, from the declarations the stylesheet really carries,
 * and asserts the width the thread is left with. It has no browser and no layout engine: the one case that
 * matters here — a row of tracks with definite minima and maxima, one flexible, and a definite amount of
 * space to fill — is fully determined, and §12.6 and §12.7 of CSS Grid say exactly what it is. The
 * agreement is checked against measurements taken in a real browser, listed in
 * `docs/specs/UX_VERIFICATION.md`: at the time of writing this file and that browser agree on every width
 * in `WIDTHS` to the pixel.
 *
 * What it therefore cannot prove: that 480px *reads* well, that nothing is clipped, that focus order is
 * sane. Those are measured in the harness and in `semantics.test.ts`, and the limits are written down.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(path.join(srcRoot, "app/globals.css"), "utf8");

/** A custom property's value, as `:root` declares it, in pixels. */
function token(name: string): number {
  const found = new RegExp(`^\\s*${name}:\\s*(?<value>-?[\\d.]+)px;`, "mu").exec(css);
  expect(found?.groups?.value, `${name} must be declared in pixels`).toBeDefined();
  return Number(found?.groups?.value);
}

/** The body of the one block whose selector list names exactly `selector`, within `within`. */
function ruleFor(selector: string, within: string = css): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const head = new RegExp(`(?:^|[\n,{}])\\s*${escaped}\\s*(?:,[^{]*)?\\{`, "u");
  const found = head.exec(within);
  expect(found, `${selector} must be declared`).not.toBeNull();
  const open = within.indexOf("{", found?.index ?? 0);
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
  return within.slice(open + 1, at);
}

/** The body of the `@container` block whose condition this is. */
function containerBlock(condition: string): string {
  const head = css.indexOf(`@container ${condition}`);
  expect(head, `@container ${condition} must exist`).toBeGreaterThan(-1);
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
  return css.slice(open + 1, at);
}

/**
 * An array element, asserted present.
 *
 * `noUncheckedIndexedAccess` is on, and rightly: a missing track or a missing pane is a defect in the
 * stylesheet rather than a case this file should silently absorb with `?? 0`. A zero would make the
 * arithmetic below quietly agree with a broken layout.
 */
function at<T>(values: readonly T[], index: number, what: string): T {
  const value = values[index];
  expect(value, `${what} must exist`).toBeDefined();
  return value as T;
}

interface Track {
  readonly min: number;
  readonly max: number;
  /** For `min(<px>, <percent>)`: the two halves, resolved against the row's own width. */
  readonly maxPx?: number;
  readonly maxPercent?: number;
  readonly flex: number;
}

/** `minmax(a, b)` and `minmax(0, 1fr)` as a track, in pixels and flex factors. */
/**
 * The top-level tracks of a `grid-template-columns` value, split on whitespace outside parentheses.
 *
 * Splitting first and parsing each track second is the point. The previous version scanned the value for
 * `minmax(` and parsed what it found, so a track written the ordinary way — `300px`, `1fr`, `auto` — was
 * not skipped with a complaint, it was **absent**: absent from the track list, and absent from the gutter
 * count, which `resolveTracks` derives from `tracks.length`. The only thing standing in the way was a
 * hard-coded `toHaveLength(2)`, which compares against a constant rather than against the number of
 * tracks the declaration names. Adding one bare track past that count produced byte-identical output —
 * same length, same flex factors, same resolved widths — while the real layout gave the thread 92px
 * against a 205px list. The guard written to prevent Issue #112 would have reported success on it.
 */
function splitTracks(declaration: string): readonly string[] {
  const tracks: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of declaration.trim()) {
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
    }
    if (depth === 0 && /\s/u.test(character)) {
      if (current !== "") {
        tracks.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (current !== "") {
    tracks.push(current);
  }
  return tracks;
}

/** A length in pixels, or `undefined` if this is not a plain pixel length. */
function pixels(value: string): number | undefined {
  const found = /^([\d.]+)px$/u.exec(value);
  return found === null ? undefined : Number(found[1]);
}

/**
 * One track's min, max and flex factor.
 *
 * Every form this stylesheet uses is handled, and **anything else fails the test** rather than being
 * ignored: an unrecognised track is a declaration this model does not describe, and a model that quietly
 * describes a different layout than the product has is worse than no model. `min(<px>, <percent>)` keeps
 * both halves, because the percentage is what holds the thread wider than the list at the narrow end of
 * the two-pane stage.
 */
function parseTrack(track: string): Track {
  const minmax = /^minmax\((?<inside>.*)\)$/u.exec(track);
  if (minmax === null) {
    // A bare track: `1fr`, `300px`, or something this model cannot speak for.
    const flex = /^([\d.]+)fr$/u.exec(track);
    if (flex !== null) {
      return { min: 0, max: Number.POSITIVE_INFINITY, flex: Number(flex[1]) };
    }
    const fixed = pixels(track);
    expect(fixed, `${track} is a track this model does not understand — teach it or do not use it`).toBeDefined();
    return { min: fixed ?? 0, max: fixed ?? 0, flex: 0 };
  }

  const inside = minmax.groups?.inside ?? "";
  let level = 0;
  let comma = -1;
  for (const [index, character] of [...inside].entries()) {
    if (character === "(") {
      level += 1;
    } else if (character === ")") {
      level -= 1;
    } else if (character === "," && level === 0) {
      comma = index;
      break;
    }
  }
  expect(comma, `${track} must be minmax(min, max)`).toBeGreaterThan(-1);
  const min = inside.slice(0, comma).trim();
  const max = inside.slice(comma + 1).trim();

  const flex = /^([\d.]+)fr$/u.exec(max);
  const capped = /^min\(\s*([\d.]+)px\s*,\s*([\d.]+)%\s*\)$/u.exec(max);
  const minPx = min === "0" ? 0 : pixels(min);
  expect(minPx, `${track}: the minimum must be a pixel length or 0`).toBeDefined();

  if (flex !== null) {
    return { min: minPx ?? 0, max: Number.POSITIVE_INFINITY, flex: Number(flex[1]) };
  }
  if (capped !== null) {
    return { min: minPx ?? 0, max: Number(capped[1]), maxPx: Number(capped[1]), maxPercent: Number(capped[2]), flex: 0 };
  }
  const maxPx = pixels(max);
  expect(maxPx, `${track}: the maximum must be a pixel length, an fr, or min(<px>, <percent>)`).toBeDefined();
  return { min: minPx ?? 0, max: maxPx ?? 0, flex: 0 };
}

/** Every track in a `grid-template-columns` value — all of them, or the test fails. */
function parseTracks(declaration: string): readonly Track[] {
  return splitTracks(declaration).map((track) => parseTrack(track));
}

/**
 * The used size of each track, for a definite amount of space to fill.
 *
 * CSS Grid §12.6 **Maximize Tracks** distributes the free space over the tracks' base sizes, freezing each
 * as it reaches its growth limit — and a flexible track's growth limit is its base size, so it does not
 * grow in this step at all. Only then does §12.7 **Expand Flexible Tracks** resolve the `fr` from what is
 * left after the non-flexible tracks' base sizes.
 *
 * That order is the whole bug: the thread is not "the rest of the row", it is the remainder after the two
 * capped tracks have taken their maxima. Writing the algorithm out is what makes that visible.
 */
function resolveTracks(tracks: readonly Track[], space: number, gap: number): readonly number[] {
  // A percentage in a track's maximum resolves against the grid's own content box, so it is known before
  // any track is sized.
  const resolved = tracks.map((track) =>
    track.maxPercent === undefined || track.maxPx === undefined
      ? track
      : { ...track, max: Math.min(track.maxPx, (space * track.maxPercent) / 100) },
  );
  tracks = resolved;
  const base = tracks.map((track) => track.min);
  const used = [...base];

  // §12.6 — grow the non-flexible tracks towards their growth limits, equally, while space remains.
  let free = space - gap * (tracks.length - 1) - base.reduce((sum, size) => sum + size, 0);
  const growable = tracks.map((track, index) => track.flex === 0 && track.max > at(base, index, "a base size"));
  while (free > 0 && growable.some(Boolean)) {
    const share = free / growable.filter(Boolean).length;
    let spent = 0;
    for (const [index, track] of tracks.entries()) {
      if (!growable[index]) {
        continue;
      }
      const room = track.max - at(used, index, "a used size");
      const take = Math.min(share, room);
      used[index] = at(used, index, "a used size") + take;
      spent += take;
      if (at(used, index, "a used size") >= track.max) {
        growable[index] = false;
      }
    }
    free -= spent;
    if (spent === 0) {
      break;
    }
  }

  // §12.7 — the fr is what is left over the non-flexible tracks' used sizes.
  const flexSum = tracks.reduce((sum, track) => sum + track.flex, 0);
  if (flexSum > 0) {
    const taken = tracks.reduce((sum, track, index) => (track.flex === 0 ? sum + at(used, index, "a used size") : sum), 0);
    const leftover = Math.max(0, space - gap * (tracks.length - 1) - taken);
    for (const [index, track] of tracks.entries()) {
      if (track.flex > 0) {
        used[index] = (leftover * track.flex) / flexSum;
      }
    }
  }

  return used;
}

/**
 * The main column's content box at a viewport width, from the shell's own declarations.
 *
 * The 720px block changes **two** things and both have to be here. It drops `.shell` to one column, so
 * the navigation costs nothing below the bound — and it re-declares `.shell-main { padding: var(--space-4) }`,
 * 16px a side instead of 24. Subtracting `--space-5` at every width made this 16px too narrow below 721px:
 * 272px at a 320px window where the real content box is 288px, which is what this PR's own spec table
 * says. No assertion depended on it, because the only loop that calls it below 900px discards the value —
 * which is exactly why it was worth fixing rather than noting. The next person to add a narrow width to
 * the measured table would have been asserting against a model that was wrong by a token.
 */
function mainContentBox(viewport: number): number {
  const nav = token("--shell-nav-width");
  const cap = token("--content-max");
  const narrow = viewport <= 720;
  const padding = (narrow ? token("--space-4") : token("--space-5")) * 2;
  const main = narrow ? viewport : viewport - nav;
  return Math.min(main, cap) - padding;
}

const THREE_PANE_CONDITION = "main (min-width: 1124px)";

/** Every width the product claims to support, plus the boundaries of the band Issue #112 was about. */
const WIDTHS = [320, 375, 430, 720, 768, 900, 901, 960, 1024, 1180, 1244, 1245, 1403, 1404, 1440, 1920] as const;

describe("the Inbox's reading thread", () => {
  const gap = token("--gap");
  const twoPane = parseTracks(/grid-template-columns:\s*(?<value>[^;]+);/u.exec(ruleFor(".inbox"))?.groups?.value ?? "");
  const threePane = parseTracks(
    /grid-template-columns:\s*(?<value>[^;]+);/u.exec(ruleFor(".inbox", containerBlock(THREE_PANE_CONDITION)))?.groups?.value ?? "",
  );

  it("declares two panes by default and three only inside the container query", () => {
    expect(twoPane).toHaveLength(2);
    expect(threePane).toHaveLength(3);

    // The flexible track is the thread, and it is the middle one in both stages.
    expect(twoPane.map((track) => track.flex)).toEqual([0, 1]);
    expect(threePane.map((track) => track.flex)).toEqual([0, 1, 0]);

    // And the two-pane list is a proportion, not only a cap. The cap alone left the thread narrower than
    // the list at the bottom of this stage, so the proportion is the part doing the work.
    expect(at(twoPane, 0, "the list track").maxPercent, "the list is capped at a share of the column too").toBeLessThanOrEqual(34);
  });

  it("sets the three-pane threshold to the width the rule requires, not a number somebody liked", () => {
    // The reading column must be at least half again as wide as the widest pane beside it. Recomputed
    // from the track caps the stylesheet actually declares, so widening the list or the context panel
    // without moving the threshold fails here instead of re-collapsing the thread.
    const list = at(threePane, 0, "the list track");
    const context = at(threePane, 2, "the context track");
    const minimumThread = 1.5 * list.max;
    const required = list.max + context.max + 2 * gap + minimumThread;

    expect(minimumThread, "half again as wide as the 320px list").toBe(480);
    expect(required).toBe(1124);
    expect(css, "and that is the condition the stylesheet asks").toContain(`@container ${THREE_PANE_CONDITION}`);
  });

  it("never lays the thread out narrower than a pane beside it", () => {
    const narrower: string[] = [];
    for (const viewport of WIDTHS) {
      const room = mainContentBox(viewport);
      // Below the 900px bound the Inbox is one pane at a time; that stage is `breakpoints.test.ts`'s.
      if (viewport <= 900) {
        continue;
      }
      const threePaneStage = room >= 1124;
      const tracks = threePaneStage ? threePane : twoPane;
      const used = resolveTracks(tracks, room, gap);
      const thread = at(used, 1, "the thread track");
      const beside = used.filter((_, index) => index !== 1);
      if (thread < Math.max(...beside)) {
        narrower.push(`${String(viewport)}px: thread ${String(Math.round(thread))} vs ${beside.map((w) => String(Math.round(w))).join("/")}`);
      }
    }

    expect(narrower, "the reading column is never the narrowest thing on screen").toEqual([]);
  });

  it("gives the thread the width a browser measured, at every claimed width", () => {
    // Taken from the harness in a real browser on this head. If the arithmetic above and these numbers
    // ever disagree, the arithmetic is the thing to distrust — which is why they are written down.
    const MEASURED: Readonly<Record<number, number>> = {
      901: 404,
      960: 444,
      1024: 486,
      1180: 591,
      1244: 634,
      1245: 635,
      1403: 791,
      1404: 480,
      1440: 516,
      1920: 668,
    };

    for (const [viewport, expected] of Object.entries(MEASURED)) {
      const room = mainContentBox(Number(viewport));
      const tracks = room >= 1124 ? threePane : twoPane;
      const thread = at(resolveTracks(tracks, room, gap), 1, "the thread track");
      expect(Math.round(thread), `${viewport}px`).toBe(expected);
    }
  });

  it("sees a track written without minmax, which is how this guard was defeatable", () => {
    // The hole the independent review proved: `parseTracks` scanned for `minmax(` and parsed what it
    // found, so a bare track was absent from the model AND from the gutter count. Adding one past the
    // hard-coded length produced byte-identical output — same length, same flex factors, same resolved
    // widths — while the real layout re-collapsed the thread. This is the regression test for that.
    const withBare = parseTracks("minmax(0, min(320px, 33%)) minmax(0, 1fr) 300px");
    expect(withBare, "three declared tracks are three tracks").toHaveLength(3);
    expect(withBare.map((track) => track.flex)).toEqual([0, 1, 0]);
    expect(at(withBare, 2, "the bare track")).toMatchObject({ min: 300, max: 300, flex: 0 });

    // And the model now answers correctly for it: three tracks, two gutters, and a thread that would
    // fail the invariant above instead of reporting 404px.
    const room = mainContentBox(901);
    const used = resolveTracks(withBare, room, gap);
    expect(Math.round(at(used, 1, "the thread track")), "the collapse the old parser could not see").toBe(92);
    expect(at(used, 1, "the thread track")).toBeLessThan(at(used, 0, "the list track"));

    // A bare `1fr` is understood too, and anything this model cannot speak for fails rather than being
    // ignored — there is no silent path left.
    expect(parseTracks("1fr 2fr").map((track) => track.flex)).toEqual([1, 2]);
  });

  it("would have failed on the layout it was written for", () => {
    // The counter-test, and the only thing that makes the rest of this file a fact about the product
    // rather than about my arithmetic: the previous head's single three-pane track list, resolved at the
    // same widths, produces the collapse that was measured in a browser — 26px at 901, 100px at 1024.
    const previous = parseTracks("minmax(260px, 320px) minmax(0, 1fr) minmax(240px, 300px)");

    // At a 901px window the thread's track came out at **zero**. The browser reported the box as 26px
    // wide, which is not a disagreement: `box-sizing: border-box` cannot render a box narrower than its
    // own 12px of padding each side plus 1px of border, so 26px was the chrome with no content inside it
    // at all. That is a sharper statement of the defect than "26px of thread".
    const previousThreadAt = (viewport: number) => at(resolveTracks(previous, mainContentBox(viewport), gap), 1, "the thread track");
    expect(Math.round(previousThreadAt(901))).toBe(0);
    expect(Math.round(previousThreadAt(1024))).toBe(100);
    expect(Math.round(previousThreadAt(1244))).toBe(320);

    // And the thread was the narrowest pane everywhere across the band, not at one unlucky width.
    for (const viewport of [901, 960, 1024, 1180, 1244]) {
      const used = resolveTracks(previous, mainContentBox(viewport), gap);
      expect(at(used, 1, "the thread track"), `${String(viewport)}px: the thread was the narrowest pane`).toBeLessThanOrEqual(
        Math.max(at(used, 0, "the list track"), at(used, 2, "the context track")),
      );
    }
  });
});
