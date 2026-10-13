/**
 * The line between operating the platform and being a customer (#59, ADMIN_OPERATIONS.md).
 *
 * This is a structural test, and it is the most important one in the slice. The tempting way to build an
 * internal console is to mint a `BusinessProfileContext` for a support engineer so that every existing
 * customer read works unchanged — and that would hand the operator customer `OWNER` authority across
 * every `requireRole` site in this package, because the context carries `role: WorkspaceRole` and nothing
 * downstream can tell a minted one from a real member's. It would also write internal actions into the
 * *customer's* audit log under a user id, readable by that customer's own owner.
 *
 * So the rule is: no function anywhere accepts both kinds of context, and the platform modules import no
 * customer-context helper and no credential helper. The moment one does, `scopeOf` stops meaning "a
 * member authorized this", and a comment would not be enough to keep that from happening.
 *
 * Parsed with the TypeScript compiler rather than matched by line, for the reason
 * `no-unlocalized-strings.test.ts` gives: a rule enforced by a regular expression is a rule that a
 * reformat defeats.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The modules that make up the internal control plane. Every one of them is held to the rules below. */
const PLATFORM_MODULES = [
  "platform-tenancy.ts",
  "platform-audit-store.ts",
  "platform-read-store.ts",
  "platform-actions-store.ts",
  "support-access-store.ts",
];

/** Types that can only come from customer authorization. A platform module naming one is the defect. */
const CUSTOMER_CONTEXT_TYPES = ["WorkspaceContext", "BusinessProfileContext"];

/**
 * Helpers that read or decrypt a provider credential.
 *
 * `ADMIN_OPERATIONS.md` requires that no raw provider secret is displayed. Tokens are envelope-encrypted
 * with the key outside the database, so a console that never calls the cipher cannot show one — this
 * keeps it that way by naming the two functions that would.
 */
const FORBIDDEN_IMPORTS = ["readChannelCredential", "getChannelAccountCredentialId", "decryptCredential", "createCredentialCipher"];

function parse(file: string): { readonly source: string; readonly ast: ts.SourceFile } {
  const source = readFileSync(path.join(here, file), "utf8");
  return { source, ast: ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS) };
}

/** Every exported function declaration's parameter type text, flattened. */
function exportedParameterTypes(ast: ts.SourceFile): { readonly fn: string; readonly type: string }[] {
  const found: { fn: string; type: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      const exported = node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
      if (exported) {
        for (const parameter of node.parameters) {
          found.push({ fn: node.name.text, type: parameter.type === undefined ? "" : parameter.type.getText(ast) });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return found;
}

describe("the platform modules", () => {
  it("never take a customer's authorization context", () => {
    const offenders: string[] = [];
    for (const file of PLATFORM_MODULES) {
      const { ast } = parse(file);
      for (const { fn, type } of exportedParameterTypes(ast)) {
        for (const customer of CUSTOMER_CONTEXT_TYPES) {
          if (new RegExp(`\\b${customer}\\b`, "u").test(type)) {
            offenders.push(`${file}: ${fn} takes ${customer}`);
          }
        }
      }
    }

    expect(offenders, "an operator holding a customer context is an operator holding customer OWNER authority").toEqual([]);
  });

  it("never import a customer-context issuer or a credential reader", () => {
    const offenders: string[] = [];
    for (const file of PLATFORM_MODULES) {
      const { source, ast } = parse(file);
      void source;
      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) && node.importClause?.namedBindings !== undefined && ts.isNamedImports(node.importClause.namedBindings)) {
          for (const element of node.importClause.namedBindings.elements) {
            const name = element.name.text;
            if (FORBIDDEN_IMPORTS.includes(name)) {
              offenders.push(`${file} imports ${name}`);
            }
            if (name === "authorizeWorkspaceAccess" || name === "authorizeBusinessProfileAccess" || name === "scopeOf" || name === "profileScopeOf") {
              offenders.push(`${file} imports ${name}`);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
    }

    expect(offenders).toEqual([]);
  });

  it("gate every content-bearing read on a support scope, and name the metadata reads that need none", () => {
    // The pairing that makes the metadata default real. A read that returns a customer's own words takes
    // a `SupportScope`; everything else is on an explicit list here, so adding a content read without a
    // gate fails rather than passes quietly.
    const METADATA_READS = [
      "findWorkspaces",
      "readSupportSnapshot",
      "listReconciliations",
      "readEntitlementFor",
      "readActivePause",
    ];
    const { ast } = parse("platform-read-store.ts");
    const byFunction = new Map<string, string[]>();
    for (const { fn, type } of exportedParameterTypes(ast)) {
      byFunction.set(fn, [...(byFunction.get(fn) ?? []), type]);
    }

    const ungated = [...byFunction.entries()]
      .filter(([fn, types]) => !METADATA_READS.includes(fn) && !types.some((type) => /\bSupportScope\b/u.test(type)))
      .map(([fn]) => fn);

    expect(ungated, "a read that is neither on the metadata list nor gated on a support scope").toEqual([]);
    // And the list is not just every function: at least one read really is gated.
    expect([...byFunction.entries()].some(([, types]) => types.some((type) => /\bSupportScope\b/u.test(type)))).toBe(true);
  });

  it("would notice each of these if one were introduced", () => {
    // Otherwise the three checks above pass because the matchers are broken rather than because the
    // modules are clean.
    const sample = `
      import { scopeOf } from "./tenancy";
      export async function readThing(db: DbExecutor, context: WorkspaceContext): Promise<void> {}
    `;
    const ast = ts.createSourceFile("sample.ts", sample, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const parameters = exportedParameterTypes(ast);

    expect(parameters.some(({ type }) => /\bWorkspaceContext\b/u.test(type))).toBe(true);
    expect(sample).toContain("scopeOf");
  });

  it("covers every module it claims to, so a clean result means something", () => {
    for (const file of PLATFORM_MODULES) {
      expect(() => parse(file), file).not.toThrow();
    }
    expect(PLATFORM_MODULES.length).toBeGreaterThan(4);
  });
});
