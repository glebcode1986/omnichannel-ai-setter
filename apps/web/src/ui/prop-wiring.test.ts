/**
 * A conditionally spread JSX attribute must be a prop something actually declares.
 *
 * This gate exists because of a defect TypeScript cannot see. `exactOptionalPropertyTypes` makes
 * `prop={undefined}` an error, so this codebase passes optional props as `{...(cond ? { prop: v } : {})}`
 * — and **a JSX spread is not checked for properties the component does not declare**. Excess-property
 * checking applies to object literals written in place, not to a spread of one. So:
 *
 *     <ChannelCards … {...(canConfigure ? { instagramConnectPath: connectPath } : {})} />
 *
 * compiled cleanly against a `ChannelCards` that had stopped declaring `instagramConnectPath` — the prop
 * had been replaced by `connect` — and the channels screen silently drew no connect button at all, on
 * every deployment, for as long as nobody opened it. `pnpm verify` was green throughout. The name
 * appeared exactly once in the whole repository: at the call site.
 *
 * So the rule is: every property name inside a conditionally spread JSX attribute must be declared as a
 * property somewhere in this repository's own types, or be an attribute the DOM defines. Nothing else is
 * a prop — it is a name being handed to a component that will ignore it.
 *
 * Walked with the TypeScript compiler rather than matched by line, for the reason
 * `route-authorization.test.ts` gives: a rule enforced by a regular expression is a rule a reformat
 * defeats. Here it also happens to be simpler — a spread attribute is one node kind.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const webSrc = path.resolve(here, "..");
const repoRoot = path.resolve(here, "../../../..");

/**
 * DOM attributes this app spreads conditionally that React declares and we do not.
 *
 * `aria-*` and `data-*` are allowed by prefix, because both are open sets by definition. This list is for
 * the named attributes outside those two, and it is deliberately short: a new entry is a decision to make
 * once, in view, rather than a hole in the rule.
 */
const DOM_ATTRIBUTES: ReadonlySet<string> = new Set(["focusable"]);

function sourceFilesUnder(root: string, extensions: readonly string[]): readonly string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const full = path.join(directory, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== "node_modules" && entry !== "generated" && entry !== ".next") {
          walk(full);
        }
        continue;
      }
      if (extensions.some((extension) => entry.endsWith(extension)) && !entry.includes(".test.")) {
        found.push(full);
      }
    }
  };
  walk(root);
  return found;
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function propertyNameOf(property: ts.ObjectLiteralElementLike): string | undefined {
  if (ts.isShorthandPropertyAssignment(property)) {
    return property.name.text;
  }
  if (!ts.isPropertyAssignment(property)) {
    return undefined;
  }
  const { name } = property;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
    return name.text;
  }
  // A computed key is not a name this gate can judge, and nothing in this app uses one here.
  return undefined;
}

/** Every property name handed to a component through a conditionally spread attribute. */
function conditionallySpreadProps(): ReadonlyMap<string, readonly string[]> {
  const sites = new Map<string, string[]>();
  for (const file of sourceFilesUnder(webSrc, [".tsx"])) {
    const source = parse(file);
    const visit = (node: ts.Node): void => {
      if (ts.isJsxSpreadAttribute(node)) {
        // `{...(cond ? { a } : {})}` and `{...(cond === undefined ? {} : { a })}` are the same shape with
        // the branches swapped, so both branches are read rather than whichever one looks like the value.
        const expression = ts.isParenthesizedExpression(node.expression) ? node.expression.expression : node.expression;
        if (ts.isConditionalExpression(expression)) {
          for (const branch of [expression.whenTrue, expression.whenFalse]) {
            if (!ts.isObjectLiteralExpression(branch)) {
              continue;
            }
            for (const property of branch.properties) {
              const name = propertyNameOf(property);
              if (name !== undefined) {
                const where = path.relative(repoRoot, file);
                sites.set(name, [...(sites.get(name) ?? []), where]);
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    }
  return sites;
}

/** Every property name this repository declares in a type, which is what a prop is. */
function declaredProperties(): ReadonlySet<string> {
  const declared = new Set<string>();
  const files = [
    ...sourceFilesUnder(webSrc, [".ts", ".tsx"]),
    ...readdirSync(path.join(repoRoot, "packages")).flatMap((name) => {
      const src = path.join(repoRoot, "packages", name, "src");
      return statSync(src).isDirectory() ? sourceFilesUnder(src, [".ts"]) : [];
    }),
  ];
  for (const file of files) {
    const visit = (node: ts.Node): void => {
      // A property *signature* only: an object literal's keys are values being built, not a contract a
      // component promises to read. That distinction is the whole strength of this gate — the dead prop
      // did appear as an object key, in the very expression that was broken.
      if (ts.isPropertySignature(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) {
        declared.add(node.name.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(parse(file));
  }
  return declared;
}

describe("a conditionally spread JSX attribute", () => {
  const spread = conditionallySpreadProps();
  const declared = declaredProperties();

  it("is read from somewhere, so this gate is not vacuous", () => {
    // Without this, deleting the walk would leave every assertion below passing over an empty map.
    expect(spread.size).toBeGreaterThan(5);
    expect(declared.size).toBeGreaterThan(100);
  });

  it("names a prop something declares, or an attribute the DOM defines", () => {
    const undeclared = [...spread.entries()]
      .filter(([name]) => !name.startsWith("aria-") && !name.startsWith("data-") && !DOM_ATTRIBUTES.has(name))
      .filter(([name]) => !declared.has(name))
      .map(([name, where]) => `${name} (${[...new Set(where)].join(", ")})`);

    // A name here is handed to a component that does not read it. TypeScript will not say so, because a
    // spread is not excess-property-checked, so this is the only thing that can.
    expect(undeclared).toEqual([]);
  });

  it("knows the dead prop by name, so the allowlist cannot quietly swallow one", () => {
    // The defect this gate was written for, asserted as absent rather than described in a comment. The
    // prop was removed from `ChannelCards` in favour of `connect`, and the call site stayed.
    expect(declared.has("instagramConnectPath")).toBe(false);
    expect(spread.has("instagramConnectPath")).toBe(false);
  });
});
