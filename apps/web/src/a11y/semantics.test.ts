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

/** Lines, with comment-only ones dropped so an example in a doc comment is not a finding. */
function lines(source: string): readonly { readonly line: number; readonly text: string }[] {
  return source.split("\n").map((text, index) => ({ line: index + 1, text })).filter(({ text }) => {
    const trimmed = text.trim();
    return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*");
  });
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
    const findings = scan(/<(div|span|li|td|tr|p|section|article)\b[^>]*\bonClick\b/g, (match) => `<${match[1] ?? ""}> has onClick`);

    expect(report(findings)).toEqual([]);
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
    expect(/<(button|a|input|select|textarea)\b[^>]*aria-hidden="true"/.test(sample)).toBe(true);
    expect(/role="(button|link)"/.test(sample)).toBe(true);
    expect(/<a\b(?![^>]*\bhref=)[^>]*>/.test(sample)).toBe(true);
  });
});
