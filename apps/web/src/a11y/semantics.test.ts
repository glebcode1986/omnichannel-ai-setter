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
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
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
 * Every control in a file that nothing gives a name to.
 *
 * **Walked with the compiler, because the line-window version lied.** It paired a `<label>` with the next
 * `<input|select|textarea>` inside 600 characters and then accepted any control within twelve lines of
 * that label. Converting the analytics filters to the product's own `Select` stretched one row past the
 * window, and the gate reported a search input that was plainly inside its `<label>` — a false finding,
 * and the only way to satisfy it would have been to write the markup more tightly. Ancestry is a fact the
 * AST knows exactly, so it is read rather than estimated.
 *
 * A control is a native `input`, `select` or `textarea`, **or the product's own `Select`**, which is the
 * same thing wearing our own clothes: a hidden input carrying the value and a `role="combobox"` button
 * drawing it. Leaving it out would have quietly stopped checking every row it was converted into.
 *
 * Named if an ancestor is a `<label>`, or a `<label htmlFor>` in the same file points at its `id`, or it
 * carries its own `aria-label` / `ariaLabel`. `type="hidden"` and `type="submit"` are not controls a
 * reader names.
 */
function orphanControls(source: string, file: string): readonly string[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const referenced = new Set<string>();
  const controls: { readonly node: ts.JsxSelfClosingElement | ts.JsxOpeningElement; readonly tag: string }[] = [];

  const attribute = (node: ts.JsxSelfClosingElement | ts.JsxOpeningElement, name: string): ts.JsxAttribute | undefined =>
    node.attributes.properties.find(
      (property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && ts.isIdentifier(property.name) && property.name.text === name,
    );
  /**
   * The attribute's value as written.
   *
   * Text and not a parsed value, because almost no id in this app is a string literal: they are
   * `id("persona")` and `` `move-${lead.conversationId}` ``. Reading only literals reported sixteen
   * properly labelled controls as orphans — every one of them a `<label htmlFor>` beside its control —
   * and two identical expressions are the same id by construction, which is as exact as this needs to be.
   */
  const valueText = (found: ts.JsxAttribute | undefined): string | undefined => {
    const initializer = found?.initializer;
    if (initializer === undefined) {
      return undefined;
    }
    if (ts.isStringLiteral(initializer)) {
      return JSON.stringify(initializer.text);
    }
    return ts.isJsxExpression(initializer) && initializer.expression !== undefined ? initializer.expression.getText(parsed) : undefined;
  };
  const tagOf = (node: ts.JsxSelfClosingElement | ts.JsxOpeningElement): string =>
    ts.isIdentifier(node.tagName) ? node.tagName.text : node.tagName.getText(parsed);

  /**
   * Whether this control names itself, in any of the spellings this codebase uses.
   *
   * Including through a spread, which is how a reusable control takes an optional name:
   * `{...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel })}`. The name may therefore be absent
   * at runtime — and that is fine here, because the name then comes from the *caller*, and every call site
   * is in this same scan. `select.tsx` was reported as an orphan for exactly this reason.
   */
  const carriesAnAriaLabel = (node: ts.JsxSelfClosingElement | ts.JsxOpeningElement): boolean =>
    node.attributes.properties.some((property) =>
      ts.isJsxSpreadAttribute(property)
        ? /aria-label|ariaLabel/u.test(property.getText(parsed))
        : ts.isJsxAttribute(property) && ts.isIdentifier(property.name) && ["ariaLabel"].includes(property.name.text),
    ) || node.attributes.properties.some((property) => ts.isJsxAttribute(property) && property.name.getText(parsed) === "aria-label");

  const visit = (node: ts.Node): void => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tag = tagOf(node);
      if (tag === "label") {
        const target = valueText(attribute(node, "htmlFor"));
        if (target !== undefined) {
          referenced.add(target);
        }
      }
      if (["input", "select", "textarea", "Select"].includes(tag)) {
        const type = valueText(attribute(node, "type"));
        if (type !== '"hidden"' && type !== '"submit"' && !carriesAnAriaLabel(node)) {
          controls.push({ node, tag });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);

  const insideLabel = (node: ts.Node): boolean => {
    for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
      if (ts.isJsxElement(at) && tagOf(at.openingElement) === "label") {
        return true;
      }
    }
    return false;
  };

  return controls
    .filter(({ node }) => {
        const id = valueText(attribute(node, "id"));
      return !(id !== undefined && referenced.has(id)) && !insideLabel(node);
    })
    .map(({ node, tag }) => {
      const line = parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;
      return `${String(line)} <${tag}> is neither inside a <label> nor referenced by one`;
    });
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
    const orphans = productionFiles().flatMap(({ file, source }) => orphanControls(source, file).map((what) => `${file}:${what}`));

    expect(orphans).toEqual([]);
    // And the walk can still say no. Without this, a matcher that found no controls at all would look
    // exactly like a clean repository — which is what the line-window version did on its last day.
    expect(orphanControls('<div><input name="q" /></div>', "probe.tsx")).toHaveLength(1);
    expect(orphanControls('<label>Q<input name="q" /></label>', "probe.tsx")).toEqual([]);
    expect(orphanControls('<label htmlFor="q">Q</label><Select id="q" name="q" />', "probe.tsx")).toEqual([]);
    expect(orphanControls('<div><Select name="q" /></div>', "probe.tsx")).toHaveLength(1);
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

  it("gives every screen a top-level heading, from the route or from something above it", () => {
    // The Inbox and its thread were the only two screens in the console whose outline began at `<h2>`:
    // three sibling panes and no name for the page holding them. Nothing here noticed, and the reason is
    // structural rather than an oversight — every other assertion in this file is about one file, and an
    // `<h1>` is a property of a *route*. It may be written in the page, in any layout above it, or in the
    // component the page delegates to, and all three are correct.
    //
    // So this one resolves the route instead of reading a file: the page's own source, the `layout.tsx`
    // files from its directory up to `app/`, and the local components it imports. A page whose whole body
    // is a `redirect(` renders no heading and needs none.
    //
    // Read through `lines`, which drops comments, and that is load-bearing: `subscription-card.tsx`
    // contains the text `<h1>` only inside a doc comment explaining that the route owns it. Matching raw
    // source would let any page that imports it pass on prose.
    const appRoot = path.join(uiRoot, "app");
    const declaresAnH1 = (text: string): boolean => lines(text).some(({ text: code }) => /<h1[\s>]/u.test(code));
    const read = (file: string): string => (existsSync(file) ? readFileSync(file, "utf8") : "");

    /**
     * Every local module the route can render, followed to the end.
     *
     * One level was not enough and the shortfall was concrete: `app/privacy/page.tsx` renders
     * `@/ui/legal/legal-page`, which renders `@/ui/legal/legal-document`, and the `<h1>` is in the
     * second. A route delegates as far as it likes, so the closure is followed rather than sampled —
     * and the two controls below are what keep that from turning into a check that cannot fail.
     */
    const reachable = (entry: string): readonly string[] => {
      const seen = new Set<string>();
      const texts: string[] = [];
      const queue = [entry];
      while (queue.length > 0) {
        const text = queue.shift() ?? "";
        for (const match of text.matchAll(/from "@\/([^"]+)"/gu)) {
          for (const extension of [".tsx", ".ts"]) {
            const file = path.join(uiRoot, `${match[1] ?? ""}${extension}`);
            if (seen.has(file) || !existsSync(file)) {
              continue;
            }
            seen.add(file);
            const found = readFileSync(file, "utf8");
            texts.push(found);
            queue.push(found);
          }
        }
      }
      return texts;
    };

    const screensWithNoHeading = (layoutCounts: (file: string) => boolean): readonly string[] => {
      const found: string[] = [];
      for (const { file, source } of productionFiles()) {
        if (path.basename(file) !== "page.tsx" || /\bredirect\(/u.test(source)) {
          continue;
        }
        const chain: string[] = [];
        for (let at = path.dirname(path.join(uiRoot, file)); at.startsWith(appRoot); at = path.dirname(at)) {
          chain.push(path.join(at, "layout.tsx"));
        }
        const sources = [source, ...chain.filter(layoutCounts).map(read), ...reachable(source)];
        if (!sources.some(declaresAnH1)) {
          found.push(file);
        }
      }
      return found;
    };

    expect(screensWithNoHeading(() => true)).toEqual([]);

    // Counted, so an empty result is a fact about the routes and not about the walk.
    expect(productionFiles().filter(({ file }) => path.basename(file) === "page.tsx").length).toBeGreaterThan(15);

    // And the control that matters: the Inbox's heading comes from a layout, so with that one layout
    // discounted both of its routes must come back. This is the state the console shipped in until now,
    // and it is the only thing that proves the check can still say no.
    const inbox = path.join("app", "workspaces", "[workspaceId]", "profiles", "[businessProfileId]", "inbox");
    const withoutIt = screensWithNoHeading((file) => !file.endsWith(path.join("inbox", "layout.tsx")));

    expect(withoutIt).toContain(path.join(inbox, "page.tsx"));
    expect(withoutIt).toContain(path.join(inbox, "[conversationId]", "page.tsx"));
    // Nothing else depends on that file, so discounting it may not disturb any other screen.
    expect(withoutIt).toHaveLength(2);
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

    // The two shapes almost nothing in this app writes as a string literal, and the ones the line-window
    // version of this matcher reported sixteen false findings on.
    const templated = '      <label htmlFor={`move-${id}`}>Move</label>\n      <select id={`move-${id}`} name="to" />';
    const called = '      <label htmlFor={id("persona")}>Persona</label>\n      <input id={id("persona")} name="persona" />';

    expect(orphanControls(loose, "probe.tsx")).toEqual(["2 <input> is neither inside a <label> nor referenced by one"]);
    expect(orphanControls(labelled, "probe.tsx")).toEqual([]);
    expect(orphanControls(referenced, "probe.tsx")).toEqual([]);
    expect(orphanControls(templated, "probe.tsx")).toEqual([]);
    expect(orphanControls(called, "probe.tsx")).toEqual([]);
    // And a mismatched id is still a finding, so matching by text is not matching anything.
    expect(orphanControls('<label htmlFor={id("a")}>A</label><input id={id("b")} name="b" />', "probe.tsx")).toHaveLength(1);
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
