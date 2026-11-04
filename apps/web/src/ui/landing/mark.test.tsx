// @vitest-environment jsdom
/**
 * Which face the mark is wearing — asked of the resolved cascade, not of the component.
 *
 * This test exists because of a change in where the guarantee lives. The mark used to render one set of
 * eyes or the other, so "only one face is visible" was true by construction and untestable in any useful
 * sense. It now renders both and the stylesheet decides, which bought a crossfade instead of a one-frame
 * swap — and moved the guarantee into a file no type checker reads. A typo in `[data-set="plain"]`, or a
 * later rule added *above* these with the same selector, leaves both faces drawn on top of each other:
 * four eyes, and the only symptom is a drawing that looks wrong to a person who happens to look.
 *
 * jsdom lays nothing out, but it resolves specificity and source order, which is the whole question here.
 * Each case asserts both halves — the hidden set is hidden *and* the shown set is not — because an
 * assertion that only names the hidden one passes just as well when the rule hides everything.
 */
import { cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { Mark, type MarkEyes } from "./mark";

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const css = readFileSync(path.join(srcRoot, "app/globals.css"), "utf8");

/** The body of every block opened by `header`, read to its matched brace rather than to the next `}`. */
function mediaBlocks(sheet: string, header: string): string[] {
  const bodies: string[] = [];
  let from = sheet.indexOf(header);
  while (from !== -1) {
    const open = sheet.indexOf("{", from);
    let depth = 0;
    for (let at = open; at < sheet.length; at += 1) {
      if (sheet[at] === "{") {
        depth += 1;
      } else if (sheet[at] === "}") {
        depth -= 1;
        if (depth === 0) {
          bodies.push(sheet.slice(open + 1, at));
          break;
        }
      }
    }
    from = sheet.indexOf(header, from + header.length);
  }
  return bodies;
}

function at<T>(values: readonly T[], index: number): T {
  const found = values[index];
  if (found === undefined) {
    expect.fail(`value ${String(index)} must exist`);
  }
  return found;
}

/** Every time in a declaration, in milliseconds, in the order written. */
function timesOf(declaration: string): number[] {
  return [...declaration.matchAll(/(?<value>[\d.]+)(?<unit>ms|s)\b/gu)].map((found) =>
    Number(found.groups?.value) * (found.groups?.unit === "s" ? 1000 : 1),
  );
}

function mount(eyes: MarkEyes): HTMLElement {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
  const { container } = render(<Mark eyes={eyes} title="mark" />);
  return container;
}

function opacityOf(container: HTMLElement, set: MarkEyes): string {
  const group = container.querySelector(`.mark-eyes[data-set="${set}"]`);
  expect(group, `the ${set} set must be in the markup`).not.toBeNull();
  return getComputedStyle(group as Element).opacity;
}

afterEach(() => {
  cleanup();
  document.head.innerHTML = "";
});

describe("the mark's two faces", () => {
  it("draws both sets whichever one is forward, or there is nothing to fade between", () => {
    const container = mount("sly");
    expect(container.querySelectorAll(".mark-eyes")).toHaveLength(2);
    // And each one nests its shapes, which is what keeps the crossfade and the blink off one element.
    expect(container.querySelectorAll(".mark-eyes > .mark-lids")).toHaveLength(2);
  });

  const cases: ReadonlyArray<{ readonly eyes: MarkEyes; readonly hidden: MarkEyes }> = [
    { eyes: "sly", hidden: "plain" },
    { eyes: "plain", hidden: "sly" },
  ];

  for (const { eyes, hidden } of cases) {
    it(`shows ${eyes} and hides ${hidden}`, () => {
      const container = mount(eyes);
      expect(opacityOf(container, hidden), `${hidden} must be transparent`).toBe("0");
      expect(opacityOf(container, eyes), `${eyes} must not be transparent`).not.toBe("0");
    });
  }

  it("closes the outgoing set rather than dissolving it, so two faces are never legible at once", () => {
    const container = mount("sly");
    const hidden = getComputedStyle(container.querySelector('.mark-eyes[data-set="plain"]') as Element);
    const shown = getComputedStyle(container.querySelector('.mark-eyes[data-set="sly"]') as Element);
    expect(hidden.transform, "the hidden set must be shut, not merely transparent").not.toBe("none");
    expect(hidden.transform).not.toBe(shown.transform);
  });

  it("lets the outgoing set finish before the incoming one starts", () => {
    // This is the whole reason the change does not ghost, and it is one number a later edit would
    // flatten without noticing: the state an element arrives *at* chooses the transition that runs,
    // so the visible rule carries the delay and the hidden rule must not.
    // jsdom does not expand the `transition` shorthand into longhands, so `transitionDelay` reads
    // empty and parsing the shorthand is the only way to ask. Split on commas that are not inside
    // `cubic-bezier(...)`, then read each part's *second* time, which is where a delay sits.
    const delayOf = (container: HTMLElement, set: MarkEyes): number => {
      const declared = getComputedStyle(container.querySelector(`.mark-eyes[data-set="${set}"]`) as Element);
      const shorthand = declared.transition;
      expect(shorthand, `${set} must declare a transition at all`).not.toBe("");
      const parts = shorthand.split(/,(?![^(]*\))/u);
      return Math.min(
        ...parts.map((part) => {
          const times = [...part.matchAll(/(?<value>[\d.]+)(?<unit>ms|s)\b/gu)];
          const delay = times[1];
          if (delay?.groups === undefined) {
            return 0;
          }
          return Number(delay.groups.value) * (delay.groups.unit === "s" ? 1000 : 1);
        }),
      );
    };
    const container = mount("sly");
    expect(delayOf(container, "plain"), "the set being shut must leave at once").toBe(0);
    expect(delayOf(container, "sly"), "the set being opened must wait for it").toBeGreaterThan(0);
  });

  it("makes the change instant under reduced motion, where the delay would otherwise survive", () => {
    // The one case jsdom cannot resolve: it defines no `matchMedia` and applies no `@media` block
    // at all, so a computed style here reports the unconditioned rule whatever the preference. This
    // reads the stylesheet's text instead — but by *block body*, not across the whole file, because
    // the file carries several reduced-motion blocks and a loose search would be answered by any
    // of them.
    //
    // The defect it guards is specific and was measured, not guessed: the sheet's global reduce rule
    // collapses `transition-duration` and leaves `transition-delay` alone, so the outgoing eyes
    // vanish at once while the incoming ones still wait out their delay — a blank-faced flicker
    // shown to exactly the person who asked for no movement.
    const blocks = mediaBlocks(css, "@media (prefers-reduced-motion: reduce)");
    expect(blocks.length, "the sheet must carry reduced-motion rules at all").toBeGreaterThan(0);
    expect(
      blocks.join("\n"),
      "positive control: the extractor must be returning real rule bodies, not empty strings",
    ).toContain(".demo-caret");

    const governing = blocks.find((body) => body.includes(".mark-eyes"));
    expect(governing, "the change of expression must be addressed under reduced motion").toBeDefined();
    expect(governing ?? "").toMatch(/transition:\s*none/u);
  });

  it("waits for the lean to finish before the breathing starts", () => {
    // Another measured defect rather than a matter of taste. An animation owns its property from
    // its own first frame and cancels a transition on that property outright: before these delays
    // existed, changing phase put the character in the finished pose on frame one and
    // `getAnimations()` listed no transition at all, so the 500ms lean the stylesheet declares had
    // never once been seen. The delay hands the property to the transition first.
    //
    // Asserted as a relation between two numbers, not as the literal `500ms`, because the point is
    // that they agree: shortening the lean and leaving the delay behind is not a defect, but
    // lengthening it and leaving the delay behind is this same bug again.
    // `.keeper {` opens more than one rule — the narrow-screen block reopens it — and `.keeper .mark-body`
    // declares a `transition` of its own for the colour. Picking "the first" would quietly measure the
    // wrong one, so take every `.keeper {` body and keep the ones that actually declare a transition.
    const leans = mediaBlocks(css, ".keeper {")
      .map((body) => /transition:[^;]+/u.exec(body)?.[0])
      .filter((found): found is string => found !== undefined)
      .map((found) => timesOf(found));
    expect(leans, "exactly one .keeper rule may declare the lean").toHaveLength(1);
    const lean = at(leans, 0);
    expect(lean, "the lean must declare a duration").toHaveLength(1);

    const motion = mediaBlocks(css, "@media (prefers-reduced-motion: no-preference)").find((body) =>
      body.includes("keeper-hold"),
    );
    expect(motion, "the idle motion must be declared under no-preference").toBeDefined();

    for (const name of ["keeper-think", "keeper-hold"]) {
      const declared = new RegExp(`animation:\\s*${name}[^;]+`, "u").exec(motion ?? "")?.[0];
      expect(declared, `${name} must be declared`).toBeDefined();
      const [duration, delay] = timesOf(declared ?? "");
      expect(duration, `${name} must have a duration`).toBeGreaterThan(0);
      expect(delay, `${name} must not start before the lean has finished`).toBeGreaterThanOrEqual(at(lean, 0));
    }
  });

  it("gives the tail its own element, so it can move without the body", () => {
    const container = mount("sly");
    const tail = container.querySelector(".mark-tail");
    expect(tail, "the tail must be addressable on its own").not.toBeNull();
    // Inside the body group: it has to inherit the body's fill, or it would not merge with the shell.
    expect((tail as Element).closest(".mark-body")).not.toBeNull();
  });
});
