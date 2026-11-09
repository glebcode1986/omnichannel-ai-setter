/**
 * Where a key written inside a conditional object spread is invisible to the type checker.
 *
 * `...(x === undefined ? {} : { identifier: x })` is how this repository passes an optional field it may
 * not have. Renaming that key to `identifierZZ` produces **no** diagnostic: excess-property checking does
 * not apply to the result of a spread, so the key is simply dropped and the call still compiles. Written
 * as a plain property the very same key raises `TS2561`, which is the control that shows the checker knows
 * the name and is blind only to this form. Measured on `sign-in-guard.ts` the mistake is caught by two
 * tests per dimension — but only because those tests assert the field, which is not true everywhere.
 *
 * A text search over-reports the problem badly, because many of these spreads target a type with a string
 * index signature (`LogFields = Readonly<Record<string, unknown>>`, Prisma's `JsonObject`) where **any**
 * key is legal and a guard would assert nothing. So the count has to come from the type checker: this
 * audit resolves the contextual type of the object literal each spread sits in and reports, per package,
 * how many spreads target a declared key set and are therefore worth guarding.
 *
 * Run it with `pnpm audit:spread-keys`. `spread-key-audit.test.ts` pins the classifier against fixtures,
 * and `--max-unguarded` lets CI hold the guarded total once a package is clean.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Why a spread is or is not worth guarding.
 *
 * Two of these are the classifications a text search gets wrong. `indexSignature`: the target accepts any
 * key, so `satisfies` would assert nothing. `weakTypeMayCatch`: the target's every property is optional
 * **and** the object literal carries nothing but spreads, so if every key in it were unknown the whole
 * literal would have no property in common with the target and `TS2559` fires by itself — measured, not
 * assumed. That protection is partial: it stops a lone misspelling, and says nothing when the same branch
 * also writes one key that is spelled right. `exposed` is everything else, where a renamed key compiles.
 */
export type SpreadVerdict = "exposed" | "guarded" | "indexSignature" | "weakTypeMayCatch" | "noContextualType";

/**
 * Where the object literal sits, which is what decides how much a dropped key costs.
 *
 * `filter` is the one to fear: a key that disappears from a Prisma `where` does not fail, it **widens the
 * query**, and that is how a paged read once returned another Business Profile's rows. `write` loses a
 * column. `value` is an ordinary object whose own type usually requires the field anyway.
 */
export type SpreadRole = "filter" | "write" | "value";

/** Prisma argument names, by what losing a key from them does. */
const FILTER_PROPERTIES = new Set(["where", "having", "cursor"]);
const WRITE_PROPERTIES = new Set(["data", "create", "update", "select", "orderBy", "include", "omit"]);

export interface SpreadSite {
  readonly file: string;
  readonly line: number;
  readonly verdict: SpreadVerdict;
  readonly role: SpreadRole;
  /**
   * Identifies the object literal this spread sits in, so two spreads in the same literal can be compared.
   *
   * That comparison finds a second failure this form hides, and one `satisfies` cannot: two conditional
   * spreads writing the **same** key. Both are individually valid, so every type check passes — and at
   * run time the later spread replaces the earlier one's object outright, so when both conditions hold the
   * first filter is silently gone. Measured in `review-queue-store.ts`, where `conversation` is written
   * twice.
   */
  readonly container: string;
  /** The keys the spread's branches write, for the report. */
  readonly keys: readonly string[];
  /** The contextual type the object literal was checked against, as the checker prints it. */
  readonly target: string;
}

/**
 * The nearest enclosing Prisma argument name, by walking out of the object literal.
 *
 * The walk is what makes a nested filter count: in `where: { OR: [{ ...(x ? {} : { a }) }] }` the spread's
 * own parent is an array element, and only an ancestor says it is a filter.
 */
function roleOf(node: ts.Node): SpreadRole {
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    if (ts.isPropertyAssignment(current) && (ts.isIdentifier(current.name) || ts.isStringLiteral(current.name))) {
      if (FILTER_PROPERTIES.has(current.name.text)) {
        return "filter";
      }
      if (WRITE_PROPERTIES.has(current.name.text)) {
        return "write";
      }
    }
  }
  return "value";
}

/**
 * Strip the wrappers that stand between a branch and its object literal.
 *
 * `satisfies` and `as` have to be peeled here as well as recognised by `isGuarded`: without this, a site
 * that *was* guarded had no branch literal, was dropped as "writes no key", and never reached the report
 * at all — so the guarded column read zero because nothing could ever be counted into it.
 */
function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isAsExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** A spread whose branches write no key at all cannot carry a typo, so it is not a site. */
function branchObjectLiterals(expression: ts.Expression): readonly ts.ObjectLiteralExpression[] {
  const unwrapped = unwrap(expression);
  const candidates: ts.Expression[] = [];
  if (ts.isConditionalExpression(unwrapped)) {
    candidates.push(unwrapped.whenTrue, unwrapped.whenFalse);
  } else if (ts.isBinaryExpression(unwrapped) && isConditionalOperator(unwrapped.operatorToken.kind)) {
    candidates.push(unwrapped.left, unwrapped.right);
  } else {
    return [];
  }
  return candidates
    .map((candidate) => unwrap(candidate))
    .filter((candidate): candidate is ts.ObjectLiteralExpression => ts.isObjectLiteralExpression(candidate))
    .filter((literal) => literal.properties.length > 0);
}

function isConditionalOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.AmpersandAmpersandToken ||
    kind === ts.SyntaxKind.BarBarToken ||
    kind === ts.SyntaxKind.QuestionQuestionToken
  );
}

/** Already guarded: the branch states the shape it must satisfy, so a renamed key is an error again. */
function isGuarded(expression: ts.Expression): boolean {
  if (ts.isSatisfiesExpression(expression) || ts.isAsExpression(expression)) {
    return true;
  }
  const unwrapped = ts.isParenthesizedExpression(expression) ? expression.expression : expression;
  if (ts.isSatisfiesExpression(unwrapped) || ts.isAsExpression(unwrapped)) {
    return true;
  }
  if (ts.isConditionalExpression(unwrapped)) {
    return isGuarded(unwrapped.whenTrue) || isGuarded(unwrapped.whenFalse);
  }
  if (ts.isBinaryExpression(unwrapped) && isConditionalOperator(unwrapped.operatorToken.kind)) {
    return isGuarded(unwrapped.right);
  }
  return false;
}

function writtenKeys(literals: readonly ts.ObjectLiteralExpression[]): readonly string[] {
  const keys: string[] = [];
  for (const literal of literals) {
    for (const property of literal.properties) {
      if (property.name !== undefined && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
        keys.push(property.name.text);
      }
    }
  }
  return keys;
}

/**
 * Whether the target accepts any key.
 *
 * A union is judged by its non-nullable constituents: an optional parameter is `T | undefined`, and it is
 * `T` that decides whether a key can be misspelled. If **any** constituent takes a string index, a guard
 * would pass whatever it is handed, so the site is reported as `indexSignature` rather than as guardable.
 */
function acceptsAnyKey(checker: ts.TypeChecker, type: ts.Type): boolean {
  const constituents = type.isUnion() ? type.types : [type];
  return constituents
    .filter((constituent) => (constituent.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) === 0)
    .some((constituent) => checker.getIndexTypeOfType(constituent, ts.IndexKind.String) !== undefined);
}

export interface AuditOptions {
  /** The classifier's own fixtures, which the product report excludes and `spread-key-audit.test.ts` wants. */
  readonly includeFixtures?: boolean;
}

/**
 * A weak type: every property optional, at least one of them, and no index signature.
 *
 * It matters because TypeScript refuses an object with *no* property in common with a weak type — the one
 * way an unguarded spread is checked today. `satisfies` on a weak target leans on the same rule.
 */
function isWeakType(checker: ts.TypeChecker, type: ts.Type): boolean {
  const constituents = type.isUnion() ? type.types : [type];
  return constituents
    .filter((constituent) => (constituent.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) === 0)
    .every((constituent) => {
      const properties = constituent.getProperties();
      if (properties.length === 0) {
        return false;
      }
      if (checker.getIndexTypeOfType(constituent, ts.IndexKind.String) !== undefined) {
        return false;
      }
      return properties.every((property) => (property.flags & ts.SymbolFlags.Optional) !== 0);
    });
}

export function auditProject(configPath: string, options: AuditOptions = {}): readonly SpreadSite[] {
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, " "));
    },
  });
  if (parsed === undefined) {
    throw new Error(`cannot read ${configPath}`);
  }
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const checker = program.getTypeChecker();
  const sites: SpreadSite[] = [];

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile || !sourceFile.fileName.startsWith(repoRoot)) {
      continue;
    }
    // Fixtures are the classifier's own examples, deliberately holding one of every verdict, so counting
    // them would make the report describe this audit instead of the product.
    const isFixture = sourceFile.fileName.includes("/fixtures/");
    if (
      sourceFile.fileName.includes("/node_modules/") ||
      (isFixture && options.includeFixtures !== true) ||
      /\.test\.tsx?$/.test(sourceFile.fileName)
    ) {
      continue;
    }
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        for (const property of node.properties) {
          if (!ts.isSpreadAssignment(property)) {
            continue;
          }
          const literals = branchObjectLiterals(property.expression);
          if (literals.length === 0) {
            continue;
          }
          const contextual = checker.getContextualType(node);
          // A sibling the target knows is what silences the checker: with one present the literal always
          // has a property in common, so the weak-type rule never fires and the spread is unchecked.
          //
          // **Any** other property counts, including another spread. A spread of a typed variable
          // (`...scope`) contributes that variable's known properties, and a sibling conditional spread
          // contributes its own correctly spelled key — this audit measures what one renamed key costs, so
          // the sibling is still spelled right. Counting only non-spread properties excused a whole class
          // of `where` clauses built entirely out of spreads, which is the commonest shape in this
          // repository's stores.
          const hasKnownSibling = node.properties.length > 1;
          const verdict: SpreadVerdict = isGuarded(property.expression)
            ? "guarded"
            : contextual === undefined
              ? "noContextualType"
              : acceptsAnyKey(checker, contextual)
                ? "indexSignature"
                : !hasKnownSibling && isWeakType(checker, contextual)
                  ? "weakTypeMayCatch"
                  : "exposed";
          sites.push({
            file: path.relative(repoRoot, sourceFile.fileName),
            line: sourceFile.getLineAndCharacterOfPosition(property.getStart(sourceFile)).line + 1,
            verdict,
            role: roleOf(node),
            container: `${path.relative(repoRoot, sourceFile.fileName)}@${node.getStart(sourceFile)}`,
            keys: writtenKeys(literals),
            target: contextual === undefined ? "—" : checker.typeToString(contextual).slice(0, 60),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return sites;
}
