/**
 * No user-facing English left in the production UI (Issue #58).
 *
 * The acceptance criterion says new Phase 5 work must *fail review* when it introduces unlocalized
 * strings. A rule that only lives in a document is a rule that gets forgotten on a busy Friday, so it is
 * also this test.
 *
 * It is deliberately narrow: JSX text nodes, and the attributes that become an accessible name. A guard
 * that cried wolf about every string literal would be switched off within a week, and then it would be
 * protecting nothing. What it does not catch remains a review responsibility — the spec says so.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEARCHED = ["app", "ui"];
/** Text that is not prose: identifiers, single symbols, numbers, punctuation. */
const NOT_PROSE = /^[\s\d\p{P}\p{S}]*$/u;

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function productionFiles(): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const full = path.join(directory, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      // Tests are not production UI, and neither is anything that is not a component.
      if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        found.push(full);
      }
    }
  };
  for (const group of SEARCHED) {
    walk(path.join(uiRoot, group));
  }
  return found;
}

/** JSX text between tags: `>Some words<`, which is the commonest way English gets left behind. */
function jsxTextLiterals(source: string): { line: number; text: string }[] {
  const found: { line: number; text: string }[] = [];
  source.split("\n").forEach((line, index) => {
    if (line.trim().startsWith("*") || line.trim().startsWith("//")) {
      return;
    }
    for (const match of line.matchAll(/>([^<>{}\n]+)</g)) {
      const text = (match[1] ?? "").trim();
      // A TypeScript type expression can look like JSX text: `=> void | Promise<void>` puts prose-shaped
      // characters between a `>` and a `<`. Union bars and arrows never appear in a rendered sentence.
      if (text === "" || NOT_PROSE.test(text) || text.includes("|") || text.includes("=>")) {
        continue;
      }
      found.push({ line: index + 1, text });
    }
  });
  return found;
}

/** Attributes that a screen reader reads out. An English one of these is as broken as English prose. */
function accessibleNameLiterals(source: string): { line: number; text: string }[] {
  const found: { line: number; text: string }[] = [];
  source.split("\n").forEach((line, index) => {
    if (line.trim().startsWith("*") || line.trim().startsWith("//")) {
      return;
    }
    for (const match of line.matchAll(/\b(aria-label|title|placeholder|alt)="([^"]+)"/g)) {
      const text = (match[2] ?? "").trim();
      if (text !== "" && !NOT_PROSE.test(text)) {
        found.push({ line: index + 1, text: `${match[1] ?? ""}="${text}"` });
      }
    }
  });
  return found;
}

describe("the production UI", () => {
  it("has no user-facing text outside the catalogues", () => {
    const findings: Finding[] = [];
    for (const file of productionFiles()) {
      const source = readFileSync(file, "utf8");
      const relative = path.relative(uiRoot, file);
      for (const hit of [...jsxTextLiterals(source), ...accessibleNameLiterals(source)]) {
        findings.push({ file: relative, line: hit.line, text: hit.text });
      }
    }

    expect(
      findings.map((finding) => `${finding.file}:${String(finding.line)} ${finding.text}`),
      "user-facing text must come from a catalogue, not a literal",
    ).toEqual([]);
  });

  it("would notice a literal if one were added", () => {
    // Otherwise the check above passes because its matcher is broken rather than because the UI is clean.
    const sample = [
      '      <p>Nothing is sent to a customer until you activate.</p>',
      '      <button aria-label="Close this">{t.t("setup.skip")}</button>',
      '      readonly action: (formData: FormData) => void | Promise<void>;',
    ].join("\n");

    // The prose is caught, the accessible name is caught, and the type annotation is not.
    expect(jsxTextLiterals(sample).map((hit) => hit.text)).toEqual(["Nothing is sent to a customer until you activate."]);
    expect(accessibleNameLiterals(sample)).toHaveLength(1);
  });

  it("does not object to markup that carries no prose", () => {
    const sample = `      <span>{t.t("nav.inbox")}</span>\n      <div data-tone="ok" />\n      <li>—</li>\n      <td>42</td>\n`;

    expect(jsxTextLiterals(sample)).toEqual([]);
    expect(accessibleNameLiterals(sample)).toEqual([]);
  });

  it("looks at every production UI file, so a clean result means something", () => {
    const files = productionFiles();

    expect(files.length).toBeGreaterThan(10);
    expect(files.some((file) => file.endsWith("setup-checklist.tsx"))).toBe(true);
    expect(files.some((file) => file.includes(`${path.sep}app${path.sep}`))).toBe(true);
    expect(files.some((file) => file.endsWith(".test.tsx"))).toBe(false);
  });
});
