/**
 * No user-facing English left in the production UI (Issue #58).
 *
 * The acceptance criterion says new Phase 5 work must *fail review* when it introduces unlocalized
 * strings. A rule that only lives in a document is a rule that gets forgotten on a busy Friday, so it is
 * also this test.
 *
 * **It parses the JSX rather than reading lines.** The first version matched `>text<` with a regular
 * expression, one line at a time, and an independent review showed three ways past it that are not
 * exotic syntax but ordinary formatting:
 *
 * ```tsx
 * <p>
 *   This hard-coded sentence reaches the customer.
 * </p>
 * <p>{"This hard-coded sentence reaches the customer."}</p>
 * <button aria-label='Close dialog'>×</button>
 * ```
 *
 * None was reported. A guard with known holes is worse than no guard, because it is cited as coverage.
 *
 * The compiler's own parser removes the whole class: a JSX text node is a JSX text node however it is
 * wrapped, a string in a JSX expression is a string, and an attribute's value does not care which quotes
 * it arrived in. It also removes the heuristics the regex needed — the old version had to exclude `|` and
 * `=>` so that `=> void | Promise<void>` was not read as prose, and a parser simply never offers a type
 * annotation as JSX text.
 *
 * Still deliberately narrow in *what* it judges: JSX text, string literals rendered as JSX children, and
 * the attributes that become an accessible name. A guard that cried wolf about every string literal in
 * the codebase would be switched off within a week. What it does not catch remains a review
 * responsibility — the spec says so.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEARCHED = ["app", "ui"];
/** Text that is not prose: identifiers, single symbols, numbers, punctuation. */
const NOT_PROSE = /^[\s\d\p{P}\p{S}]*$/u;
/** Attributes a screen reader reads out. An English one of these is as broken as English prose. */
const ACCESSIBLE_NAME_ATTRIBUTES = new Set(["aria-label", "title", "placeholder", "alt"]);

/*
 * Attributes a stylesheet draws on screen with `content: attr(...)`. They are not accessible names — the
 * lead cards give theirs an empty alternative text on purpose, because the restored table roles already
 * name the column — but they are read by a person looking at a phone, which is the whole reason this gate
 * exists. A column name hardcoded into one would show in English on a Russian console with nothing to
 * report it.
 */
const DRAWN_TEXT_ATTRIBUTES = new Set(["data-label"]);

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

const isProse = (text: string): boolean => text.trim() !== "" && !NOT_PROSE.test(text.trim());

/**
 * The user-facing literals in one file, found structurally.
 *
 * Exported shape rather than an inline walk so the adversarial cases below can run the *same* logic over
 * a sample with a known answer. A clean repository and a broken checker look identical otherwise.
 */
export function unlocalizedLiterals(fileName: string, source: string): readonly Finding[] {
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings: Finding[] = [];
  const lineOf = (node: ts.Node): number => parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;
  const report = (node: ts.Node, text: string): void => {
    findings.push({ file: fileName, line: lineOf(node), text: text.trim() });
  };

  /** A string the source wrote literally, whichever quotes or template it used. */
  const literalText = (node: ts.Node | undefined): string | undefined => {
    if (node === undefined) {
      return undefined;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return node.text;
    }
    // `attr={"text"}` and `{"text"}` as a child: the literal is one level in.
    if (ts.isJsxExpression(node)) {
      return literalText(node.expression);
    }
    return undefined;
  };

  const visit = (node: ts.Node): void => {
    // Rendered text, multiline included: the parser hands over the whole node, not a line of it.
    if (ts.isJsxText(node) && !node.containsOnlyTriviaWhiteSpaces && isProse(node.text)) {
      report(node, node.text);
    }

    // A string literal rendered as a child: `<p>{"text"}</p>`.
    if (ts.isJsxExpression(node) && node.parent !== undefined && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      const text = literalText(node);
      if (text !== undefined && isProse(text)) {
        report(node, text);
      }
    }

    // An accessible name or a label a stylesheet draws, in either quote style or as an expression.
    if (
      ts.isJsxAttribute(node) &&
      (ACCESSIBLE_NAME_ATTRIBUTES.has(node.name.getText(parsed)) || DRAWN_TEXT_ATTRIBUTES.has(node.name.getText(parsed)))
    ) {
      const text = literalText(node.initializer);
      if (text !== undefined && isProse(text)) {
        report(node, `${node.name.getText(parsed)}="${text}"`);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(parsed);
  return findings;
}

describe("the production UI", () => {
  it("has no user-facing text outside the catalogues", () => {
    const findings = productionFiles().flatMap((file) =>
      unlocalizedLiterals(path.relative(uiRoot, file), readFileSync(file, "utf8")),
    );

    expect(
      findings.map((finding) => `${finding.file}:${String(finding.line)} ${finding.text}`),
      "user-facing text must come from a catalogue, not a literal",
    ).toEqual([]);
  });

  describe("and the checker itself", () => {
    const found = (source: string) => unlocalizedLiterals("sample.tsx", source).map((finding) => finding.text);

    it("catches text on one line", () => {
      expect(found("const a = <p>This one is caught.</p>;")).toEqual(["This one is caught."]);
    });

    it("still catches a single word, which is what a narrower checker would lose", () => {
      // Carried over from the regex version, which had to skip `=>` to avoid reading a return type as
      // prose and so risked losing short text. "Send" on a button is exactly the literal this whole
      // check exists for, and the parser has no such trade to make.
      expect(found('const a = <button type="submit">Send</button>;')).toEqual(["Send"]);
    });

    it("catches text spread over several lines, which is ordinary formatting", () => {
      // The first bypass the review found. Line-at-a-time matching never saw it.
      expect(found("const a = (\n  <p>\n    This hard-coded sentence reaches the customer.\n  </p>\n);")).toEqual([
        "This hard-coded sentence reaches the customer.",
      ]);
    });

    it("catches a string literal rendered as a child", () => {
      // The second bypass: no `>text<` for a regex to match.
      expect(found('const a = <p>{"This hard-coded sentence reaches the customer."}</p>;')).toEqual([
        "This hard-coded sentence reaches the customer.",
      ]);
      expect(found("const a = <p>{'Single quotes too.'}</p>;")).toEqual(["Single quotes too."]);
      expect(found("const a = <p>{`And a template.`}</p>;")).toEqual(["And a template."]);
    });

    it("catches an accessible name in either quote style", () => {
      // The third bypass: the old matcher only recognised double quotes.
      expect(found(`const a = <button aria-label='Close dialog'>×</button>;`)).toEqual(['aria-label="Close dialog"']);
      expect(found('const a = <button aria-label="Close dialog">×</button>;')).toEqual(['aria-label="Close dialog"']);
      expect(found('const a = <button aria-label={"Close dialog"}>×</button>;')).toEqual(['aria-label="Close dialog"']);
      expect(found('const a = <img alt="A photograph of the shop" src="x" />;')).toEqual(['alt="A photograph of the shop"']);
    });

    it("catches text inside a fragment", () => {
      expect(found("const a = <>\n  Loose prose in a fragment.\n</>;")).toEqual(["Loose prose in a fragment."]);
    });

    it("accepts a catalogue call, which is the whole point", () => {
      expect(found('const a = <p>{t.t("nav.inbox")}</p>;')).toEqual([]);
      expect(found('const a = <button aria-label={t.t("inbox.close")}>×</button>;')).toEqual([]);
    });

    it("does not object to markup carrying no prose", () => {
      expect(found('const a = <span data-tone="ok" />;')).toEqual([]);
      expect(found("const a = <li>—</li>;")).toEqual([]);
      expect(found("const a = <td>42</td>;")).toEqual([]);
    });

    it("never reads a type annotation as JSX text, without needing to be told about arrows and unions", () => {
      // The old version excluded `|` and `=>` by hand so `=> void | Promise<void>` was not reported as
      // the word "Promise". A parser does not offer a type as JSX text at all, so the exclusions are gone
      // — and with them the risk that a real sentence containing a bar was skipped.
      const types = [
        "type A = { readonly action: (formData: FormData) => void | Promise<void> };",
        "type B = { readonly takeOver: (target: Target, formData: FormData) => Promise<void> };",
        "type C = Record<string, Array<Map<string, Set<number>>>>;",
        "const d: Array<string> = [];",
      ].join("\n");

      expect(found(types)).toEqual([]);
    });

    it("ignores prose in a comment, including one that looks like markup", () => {
      expect(found("// <p>Not real markup.</p>\nconst a = 1;")).toEqual([]);
      expect(found("/**\n * <p>Nor this one.</p>\n */\nconst a = 1;")).toEqual([]);
      expect(found("const a = <p>{/* An explanatory aside. */}</p>;")).toEqual([]);
    });

    it("reports the line the text starts on, so a finding can be found", () => {
      const findings = unlocalizedLiterals("sample.tsx", "const a = (\n  <p>\n    Prose here.\n  </p>\n);");

      expect(findings).toHaveLength(1);
      expect(findings[0]?.line).toBe(3);
    });
  });

  it("looks at every production UI file, so a clean result means something", () => {
    const files = productionFiles();

    expect(files.length).toBeGreaterThan(10);
    expect(files.some((file) => file.endsWith("setup-checklist.tsx"))).toBe(true);
    expect(files.some((file) => file.includes(`${path.sep}app${path.sep}`))).toBe(true);
    expect(files.some((file) => file.endsWith(".test.tsx"))).toBe(false);
  });
});
