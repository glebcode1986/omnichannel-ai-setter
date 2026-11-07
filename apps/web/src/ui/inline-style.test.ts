/**
 * A component does not write the stylesheet's values into the document.
 *
 * Not a style rule for its own sake. An inline `style` is the one declaration no stylesheet can see, so
 * it cannot be read by the responsive gate, cannot be overridden by a media query, and cannot be found
 * by anybody who goes looking for where a number came from. The three that existed were all of a kind:
 * `style={{ listStyle: "none", margin: 0, padding: 0 }}` repeated on three card grids, `margin: "0 0 4px",
 * fontSize: "1.1rem"` on two card titles — a size on no scale, beside a margin restating a rule that
 * already existed — and `flexBasis: "100%"` on a checklist line. Every one of them is now a rule.
 *
 * Two kinds are allowed, and they are allowed because a stylesheet genuinely cannot hold them:
 *
 * - **a custom property**, which is a value being handed *to* the stylesheet rather than written instead
 *   of it: `style={{ "--progress": progress }}` is how a server-rendered number reaches a CSS animation.
 * - **`colorScheme` on the document root**, which is read from the person's stored preference at render
 *   and tells the browser which form controls and scrollbars to draw before any CSS applies.
 *
 * `opengraph-image.tsx` is exempt as a file: it is rendered by Satori into a PNG, with no stylesheet in
 * the picture at all, so inline style is the only styling that exists there.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const webSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Rendered to an image by Satori, where no stylesheet exists to hold anything. */
const EXEMPT_FILES = new Set(["app/opengraph-image.tsx"]);

/** Properties a stylesheet cannot know, named one by one rather than by a pattern. */
const ALLOWED_PROPERTIES = new Set(["colorScheme"]);

function componentFiles(): readonly { readonly file: string; readonly source: string }[] {
  const found: { file: string; source: string }[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const full = path.join(directory, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.endsWith(".tsx") && !entry.includes(".test.")) {
        const file = path.relative(webSrc, full);
        if (!EXEMPT_FILES.has(file)) {
          found.push({ file, source: readFileSync(full, "utf8") });
        }
      }
    }
  };
  for (const group of ["app", "ui"]) {
    walk(path.join(webSrc, group));
  }
  return found;
}

/** Every property name written into a `style={{ … }}` attribute, with where it was written. */
export function inlineStyleProperties(source: string, file = "probe.tsx"): readonly { readonly file: string; readonly property: string; readonly line: number }[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: { file: string; property: string; line: number }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === "style") {
      const initializer = node.initializer;
      const expression = initializer !== undefined && ts.isJsxExpression(initializer) ? initializer.expression : undefined;
      // `as React.CSSProperties` is how a custom property is typed, so the assertion is stepped through
      // rather than treated as something other than the object it wraps.
      const unwrapped = expression !== undefined && ts.isAsExpression(expression) ? expression.expression : expression;
      if (unwrapped !== undefined && ts.isObjectLiteralExpression(unwrapped)) {
        for (const property of unwrapped.properties) {
          if (!ts.isPropertyAssignment(property)) {
            continue;
          }
          const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : undefined;
          if (name !== undefined) {
            found.push({ file, property: name, line: parsed.getLineAndCharacterOfPosition(property.getStart(parsed)).line + 1 });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return found;
}

describe("an inline style", () => {
  it("carries only what a stylesheet cannot", () => {
    const written = componentFiles().flatMap(({ file, source }) => inlineStyleProperties(source, file));
    const offenders = written
      // A custom property is handed *to* the stylesheet, not written instead of it.
      .filter(({ property }) => !property.startsWith("--"))
      .filter(({ property }) => !ALLOWED_PROPERTIES.has(property))
      .map(({ file, property, line }) => `${file}:${String(line)} ${property}`);

    expect(offenders).toEqual([]);
  });

  it("is found at all, so the rule above is about the components and not about the walk", () => {
    // Without this, a matcher that returned nothing would look exactly like a codebase with no inline
    // styles — and this one has two legitimate ones, which it must see in order to allow them.
    const seen = componentFiles().flatMap(({ file, source }) => inlineStyleProperties(source, file));
    expect(seen.map(({ property }) => property).sort()).toEqual(["--progress", "colorScheme"]);
  });

  it("would notice each shape the product actually wrote", () => {
    // The three that were there, as they were written.
    expect(inlineStyleProperties('<ul style={{ listStyle: "none", margin: 0, padding: 0 }} />').map((f) => f.property)).toEqual([
      "listStyle",
      "margin",
      "padding",
    ]);
    expect(inlineStyleProperties('<h2 style={{ margin: "0 0 4px", fontSize: "1.1rem" }} />').map((f) => f.property)).toEqual(["margin", "fontSize"]);
    expect(inlineStyleProperties('<span style={{ flexBasis: "100%" }} />').map((f) => f.property)).toEqual(["flexBasis"]);
    // And the two allowed ones are read rather than skipped, which is what lets the filters decide.
    expect(inlineStyleProperties('<div style={{ "--progress": p } as React.CSSProperties} />').map((f) => f.property)).toEqual(["--progress"]);
    expect(inlineStyleProperties('<html style={{ colorScheme: theme }} />').map((f) => f.property)).toEqual(["colorScheme"]);
  });
});
