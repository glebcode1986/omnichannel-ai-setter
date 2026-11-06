/**
 * The semantic and keyboard failures that actually happen (Issue #35).
 *
 * This is a source check over the production UI, not a browser one, and that is a deliberate trade. A
 * browser-based auditor in jsdom sees no layout and no paint: it cannot judge contrast, focus visibility
 * or reading order, so it reports far less than its name suggests while looking authoritative. What it
 * *would* catch — a control with no accessible name, a heading out of order, a clickable `div` — is
 * findable in the source, and findable for every file at once rather than only for the components a test
 * happened to render.
 *
 * So: every production file, every time. Contrast is handled by `contrast.test.ts`, which computes real
 * WCAG ratios from the tokens. What neither can do is stated in `docs/specs/UX_VERIFICATION.md`.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEARCHED = ["app", "ui"];

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly what: string;
}

function productionFiles(): readonly { readonly file: string; readonly source: string }[] {
  const found: { file: string; source: string }[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const full = path.join(directory, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry)) {
        found.push({ file: path.relative(uiRoot, full), source: readFileSync(full, "utf8") });
      }
    }
  };
  for (const group of SEARCHED) {
    walk(path.join(uiRoot, group));
  }
  return found;
}

/**
 * Lines, with comments dropped so an example written in prose is not a finding.
 *
 * Block state rather than a guess at the first character. The old version dropped a line beginning
 * with `*`, `//` or `/*`, which covers a doc comment and misses the body of a JSX one — `{/* … *\/}`
 * wraps prose whose continuation lines begin with ordinary words. A comment in `shell-frame.tsx`
 * explaining why `tabIndex={-1}` had been *removed* was therefore reported as using it, and the only
 * way to satisfy the gate was to stop explaining the fix.
 *
 * Commented-out code is not shipped code, so ignoring all of it is the right answer and not a
 * weakening: the control below proves the matcher still fires on the real thing.
 */
function lines(source: string): readonly { readonly line: number; readonly text: string }[] {
  const kept: { line: number; text: string }[] = [];
  let inBlock = false;
  source.split("\n").forEach((raw, index) => {
    let text = raw;
    if (inBlock) {
      const close = text.indexOf("*" + "/");
      if (close === -1) {
        return;
      }
      inBlock = false;
      text = text.slice(close + 2);
    }
    for (;;) {
      const open = text.indexOf("/" + "*");
      if (open === -1) {
        break;
      }
      const close = text.indexOf("*" + "/", open + 2);
      if (close === -1) {
        inBlock = true;
        text = text.slice(0, open);
        break;
      }
      text = text.slice(0, open) + text.slice(close + 2);
    }
    const lineComment = text.indexOf("//");
    if (lineComment !== -1) {
      text = text.slice(0, lineComment);
    }
    if (text.trim() !== "") {
      kept.push({ line: index + 1, text });
    }
  });
  return kept;
}

function scan(pattern: RegExp, describeMatch: (match: RegExpMatchArray) => string | undefined): readonly Finding[] {
  const findings: Finding[] = [];
  for (const { file, source } of productionFiles()) {
    for (const { line, text } of lines(source)) {
      for (const match of text.matchAll(pattern)) {
        const what = describeMatch(match);
        if (what !== undefined) {
          findings.push({ file, line, what });
        }
      }
    }
  }
  return findings;
}

const report = (findings: readonly Finding[]): readonly string[] => findings.map((f) => `${f.file}:${String(f.line)} ${f.what}`);

/**
 * Controls in one file with no label.
 *
 * A control is named if it sits inside a `<label>`, if a label points at its id, or if it carries an
 * `aria-label`. Extracted from the test that uses it so the same logic can be run over a sample with a
 * known answer — otherwise a clean repository and a broken matcher look identical.
 */
function orphanControls(source: string): readonly string[] {
  const labelled = new Set([...source.matchAll(/<label[^>]*\bhtmlFor="([^"]+)"/g)].map((match) => match[1] ?? ""));
  const wrapped = new Set<number>();
  for (const match of source.matchAll(/<label[\s\S]{0,600}?<(?:input|select|textarea)\b/g)) {
    wrapped.add(source.slice(0, match.index ?? 0).split("\n").length);
  }
  const orphans: string[] = [];
  for (const { line, text } of lines(source)) {
    for (const match of text.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
      const attributes = match[2] ?? "";
      if (/type="(hidden|submit)"/.test(attributes) || /\baria-label=/.test(attributes)) {
        continue;
      }
      const id = /\bid="([^"]+)"/.exec(attributes)?.[1];
      const inWrappedLabel = [...wrapped].some((start) => line >= start && line - start <= 12);
      if (!(id !== undefined && labelled.has(id)) && !inWrappedLabel) {
        orphans.push(`${String(line)} <${match[1] ?? ""}> is neither inside a <label> nor referenced by one`);
      }
    }
  }
  return orphans;
}

describe("the production UI's semantics", () => {
  it("has no clickable element that is not a button or a link", () => {
    // The single most common keyboard failure: a `div` with an onClick is unreachable by Tab, invisible
    // to a screen reader as a control, and does not respond to Enter or Space.
    //
    // One shape is exempt, and it is exempt because the opposite would be the bug: an element carrying
    // `role="option"`. Options inside a listbox are deliberately *not* tab stops — focus stays on the
    // combobox and moves by `aria-activedescendant` — so turning each one into a button would give a
    // ten-item menu ten tab stops and break the pattern it is part of. The exemption is narrow: the
    // same file must also declare the `role="listbox"` the options belong to, so a lone `role="option"`
    // on a div cannot be used to wave a handler through.
    const findings = productionFiles().flatMap(({ file, source }) =>
      lines(source).flatMap(({ line, text }) => {
        const found = /<(div|span|li|td|tr|p|section|article)\b([^>]*)\bonClick\b/u.exec(text);
        if (found === null) {
          return [];
        }
        const isOption = /role="option"/u.test(found[2] ?? "") || /role="option"/u.test(text);
        if (isOption && source.includes('role="listbox"')) {
          return [];
        }
        return [{ file, line, what: `<${found[1] ?? ""}> has onClick` }];
      }),
    );

    expect(report(findings)).toEqual([]);
    // And the exemption is not the whole answer: the scan still has to be able to say no.
    expect(/<(div|span|li|td|tr|p|section|article)\b[^>]*\bonClick\b/u.test('<div className="x" onClick={go}>')).toBe(true);
  });

  it("gives every form control a name, by wrapping it in a label or pointing one at it", () => {
    // The commonest real shape in this codebase is `<label>Text<input …/></label>`, which needs no id.
    // A control that is neither wrapped nor referenced is one whose purpose a screen reader announces as
    // "edit text, blank".
    const orphans = productionFiles().flatMap(({ file, source }) => orphanControls(source).map((what) => `${file}:${what}`));

    expect(orphans).toEqual([]);
  });

  it("gives every icon-only control a name", () => {
    // A control whose whole content is an entity, a symbol or nothing at all announces as "button".
    const findings = scan(/<button\b([^>]*)>\s*(?:&[a-z]+;|[^\w\s<>{]|)\s*<\/button>/g, (match) =>
      /\baria-label(?:ledby)?=/.test(match[1] ?? "") ? undefined : "<button> has no text and no aria-label",
    );

    expect(report(findings)).toEqual([]);
  });

  it("never removes an element from the tab order it needs to be in", () => {
    // A positive tabindex reorders the whole page and is almost never what somebody meant; `-1` on a
    // control takes it out of the keyboard's reach entirely.
    const findings = scan(/tabIndex=\{(-?\d+)\}/g, (match) => {
      const value = Number(match[1]);
      return value === 0 ? undefined : `tabIndex={${String(value)}} reorders or removes a control`;
    });

    expect(report(findings)).toEqual([]);
  });

  it("does not hide a control from assistive technology", () => {
    const findings = scan(/<(button|a|input|select|textarea)\b[^>]*aria-hidden="true"/g, (match) => `<${match[1] ?? ""}> is aria-hidden`);

    expect(report(findings)).toEqual([]);
  });

  it("uses a real button for anything that acts, and a real link for anything that navigates", () => {
    // `role="button"` on a non-button is a promise to reimplement Enter, Space and focus, and nobody
    // ever does. An `<a>` with no href is not focusable at all.
    const roles = scan(/role="(button|link)"/g, (match) => `role="${match[1] ?? ""}" instead of the element itself`);
    const hrefless = scan(/<a\b(?![^>]*\bhref=)[^>]*>/g, () => "<a> with no href is not focusable");

    expect(report([...roles, ...hrefless])).toEqual([]);
  });

  it("gives every disclosure a name a person can read", () => {
    // Nothing else in this file reaches a `summary`: the icon-only check matches `<button>` and
    // `orphanControls` matches `input|select|textarea`, so a disclosure with no words in it — an icon,
    // an entity, a single glyph — passed every assertion here. A `summary` is the control that opens
    // the group, and its own text is the only name it has.
    const findings: Finding[] = [];
    for (const { file, source } of productionFiles()) {
      for (const found of source.matchAll(/<summary(?:\s[^>]*)?>([\s\S]*?)<\/summary>/gu)) {
        const inner = (found[1] ?? "")
          // JSX comments, elements and entities are not a name; a `t.t(...)` call is.
          .replaceAll(/\{\/\*[\s\S]*?\*\/\}/gu, "")
          .replaceAll(/<[^>]*>/gu, "")
          .replaceAll(/&[a-z]+;/gu, "")
          .trim();
        if (inner === "") {
          const line = source.slice(0, found.index ?? 0).split("\n").length;
          findings.push({ file, line, what: "<summary> with no readable name" });
        }
      }
    }

    expect(report(findings)).toEqual([]);
    // And there are disclosures to be wrong about.
    expect(productionFiles().filter(({ source }) => source.includes("<summary")).length).toBeGreaterThan(0);
  });

  it("keeps headings in order inside each file", () => {
    const findings: Finding[] = [];
    for (const { file, source } of productionFiles()) {
      let previous = 0;
      for (const { line, text } of lines(source)) {
        for (const match of text.matchAll(/<h([1-6])[\s>]/g)) {
          const level = Number(match[1]);
          // Skipping a level leaves a screen-reader user with a gap in the outline and no way to tell
          // whether they missed a section.
          if (previous !== 0 && level > previous + 1) {
            findings.push({ file, line, what: `<h${String(level)}> follows <h${String(previous)}>` });
          }
          previous = level;
        }
      }
    }

    expect(report(findings)).toEqual([]);
  });

  it("keeps a table a table where the stylesheet stops it being one", () => {
    // A browser reads a table element's implicit role off its computed display, so `display: block` on a
    // table, a row or a cell silently drops table, row, rowgroup and cell from the accessibility tree.
    // The stylesheet does exactly that on purpose below 900px, to lay each lead out as a card — which is
    // the width band where that table is the *only* view of a lead, the kanban board being hidden. So the
    // markup has to write the roles out, or a screen-reader user gets a run of generic blocks.
    const stylesheet = readFileSync(path.join(uiRoot, "app/globals.css"), "utf8");
    const board = readFileSync(path.join(uiRoot, "ui/leads/lead-board.tsx"), "utf8");

    expect(stylesheet, "this test exists because the stylesheet does this").toMatch(
      /\.lead-table[^{}]*\{[^{}]*display:\s*block/u,
    );

    expect(board).toContain('<table className="lead-table" role="table">');
    expect(board, "both row groups").toContain('<thead role="rowgroup">');
    expect(board).toContain('<tbody role="rowgroup">');

    // Counted, not spot-checked: a column added without its role is the way this comes back.
    const counts = (pattern: RegExp): number => [...board.matchAll(pattern)].length;
    expect(counts(/<tr\b/gu), "every row says so").toBe(counts(/role="row"/gu));
    expect(counts(/<th scope="col"/gu), "every column header says so").toBe(counts(/role="columnheader"/gu));
    expect(counts(/<th scope="row"/gu), "every row header says so").toBe(counts(/role="rowheader"/gu));
    expect(counts(/<td\b/gu), "every cell says so").toBe(counts(/role="cell"/gu));

    // And the name a cell draws for itself must not be announced on top of the column it now has again.
    expect(stylesheet, "the drawn label is for eyes only").toMatch(/content:\s*attr\(data-label\)\s*\/\s*""/u);
  });

  it("looks at every production component, so a clean result means something", () => {
    const files = productionFiles();

    expect(files.length).toBeGreaterThan(15);
    expect(files.map((entry) => entry.file)).toContain(path.join("ui", "inbox", "composer.tsx"));
    expect(files.map((entry) => entry.file)).toContain(path.join("ui", "analytics", "metrics-view.tsx"));
    expect(files.some((entry) => entry.file.endsWith(".test.tsx"))).toBe(false);
  });

  it("would notice a control with no label at all", () => {
    // The check above passes on this codebase because every control is inside its `<label>`. This is what
    // makes that a fact about the UI rather than about the matcher: the same logic, run over a file that
    // has a loose input, must find it.
    const loose = '      <div>\n        <input type="text" name="orphan" />\n      </div>';
    const labelled = '      <label>\n        Search\n        <input type="search" name="q" />\n      </label>';
    const referenced = '      <label htmlFor="named">Search</label>\n      <input id="named" type="search" />';

    expect(orphanControls(loose)).toEqual(["2 <input> is neither inside a <label> nor referenced by one"]);
    expect(orphanControls(labelled)).toEqual([]);
    expect(orphanControls(referenced)).toEqual([]);
  });

  it("would notice each failure if one were introduced", () => {
    // Otherwise every check above passes because its matcher is broken rather than because the UI is
    // sound. Asserted against the matchers directly, with a sample of each failure.
    const sample = [
      '      <div onClick={handler}>Click me</div>',
      '      <input type="text" name="loose" />',
      '      <button></button>',
      '      <span tabIndex={3}>Third</span>',
      '      <button aria-hidden="true">Gone</button>',
      '      <div role="button">Pretend</div>',
      '      <a>Nowhere</a>',
    ].join("\n");

    expect(/<(div|span|li|td|tr|p|section|article)\b[^>]*\bonClick\b/.test(sample)).toBe(true);
    expect(/<button\b([^>]*)>\s*(?:&[a-z]+;|[^\w\s<>{]|)\s*<\/button>/.test(sample)).toBe(true);
    expect(/tabIndex=\{(-?\d+)\}/.test(sample)).toBe(true);

    // And the comment filter: a real one is still seen, one being talked about is not. Without this
    // the filter above could swallow everything and every check in this file would pass empty.
    const mixed = ["<span tabIndex={-1} />", "{/* explaining why", "tabIndex={-1} was removed", "*" + "/}"].join("\n");
    const visible = lines(mixed).map((entry) => entry.text).join("\n");
    expect(visible).toContain("tabIndex={-1} />");
    expect(visible, "prose inside a JSX comment is not code").not.toContain("was removed");
    expect(/<(button|a|input|select|textarea)\b[^>]*aria-hidden="true"/.test(sample)).toBe(true);
    expect(/role="(button|link)"/.test(sample)).toBe(true);
    expect(/<a\b(?![^>]*\bhref=)[^>]*>/.test(sample)).toBe(true);
  });
});
