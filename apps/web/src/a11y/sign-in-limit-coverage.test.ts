/**
 * Every way into the sign-in endpoints is rate limited (#117).
 *
 * This app has no middleware, so the limit is applied by hand — and there are two entry points, which is
 * how this defect class starts. The HTTP endpoint is one. The product's own form is the other: in the
 * installed version `signIn()` runs `Auth()` **in process**, so a sign-in started by a server action never
 * passes through the route. A limiter on one of them guards every caller except the one the product ships.
 *
 * So this walks the tree instead of trusting that somebody will remember. Written as an AST walk rather
 * than a substring scan for the reason the i18n gate gives: a rule enforced by a regular expression is a
 * rule a reformat defeats.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const webSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The guard's two shapes: the shared decision, and the request-level wrapper that calls it. */
const GUARDS = ["signInAttemptAllowed", "guardSignInRequest"];

/** `auth.ts` defines `signIn` and must not guard itself; its callers are what this is about. */
const DEFINITION = path.join(webSrc, "auth.ts");

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const absolute = path.join(directory, entry);
    if (statSync(absolute).isDirectory()) {
      return walk(absolute);
    }
    return /\.tsx?$/u.test(entry) && !/\.test\.tsx?$/u.test(entry) ? [absolute] : [];
  });
}

/** Whether a file calls `signIn(...)` — by AST, so a reformat or a rename of the import cannot hide it. */
function callsSignIn(source: string, file: string): boolean {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) {
      return;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "signIn") {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return found;
}

function mentionsGuard(source: string): boolean {
  return GUARDS.some((guard) => source.includes(guard));
}

describe("every entry point to the sign-in endpoints", () => {
  const files = walk(webSrc).filter((file) => file !== DEFINITION);

  it("applies the rate limit, whether it is reached over HTTP or through a server action", () => {
    const unguarded = files.filter((file) => {
      const source = readFileSync(file, "utf8");
      return callsSignIn(source, file) && !mentionsGuard(source);
    });

    expect(
      unguarded.map((file) => path.relative(webSrc, file)),
      "a path to the sign-in endpoints that nothing rate limits",
    ).toEqual([]);
  });

  it("keeps the HTTP endpoint behind the guard, which is the only choke point this app has", () => {
    const route = readFileSync(path.join(webSrc, "app/api/auth/[...nextauth]/route.ts"), "utf8");

    expect(mentionsGuard(route), "the auth route must not become a bare re-export again").toBe(true);
  });

  it("found the server action that starts a sign-in, so the walk is not passing because it found nothing", () => {
    // Otherwise this suite goes green the day the walk stops matching anything at all.
    const callers = files.filter((file) => callsSignIn(readFileSync(file, "utf8"), file));

    expect(callers.map((file) => path.relative(webSrc, file))).toContain("server/sign-in-actions.ts");
  });

  it("would notice a new unguarded caller", () => {
    // The counter-test. A sample that calls `signIn` and mentions no guard must be reported by exactly the
    // predicate this suite uses, or the walk above proves only that the matcher is broken.
    const sample = 'import { signIn } from "../auth";\nexport async function go() {\n  await signIn("nodemailer", {});\n}\n';

    expect(callsSignIn(sample, "sample.ts")).toBe(true);
    expect(mentionsGuard(sample)).toBe(false);

    // And a guarded one is not reported.
    const guarded = `${sample}// signInAttemptAllowed\n`;
    expect(callsSignIn(guarded, "sample.ts") && !mentionsGuard(guarded)).toBe(false);
  });
});
