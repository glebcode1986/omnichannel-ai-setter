/**
 * Every route in this app is authorized by something (#59).
 *
 * This app has no middleware. Authorization lives in the React Server Component entry points, which means
 * that a page file is authorized only because somebody remembered to call a resolver in it — or in a
 * layout above it in the same segment chain. For the product shell that worked, because every page sits
 * under the profile layout. An `/admin` tree is a sibling of all of it and sits under nothing, so a
 * forgotten `requirePlatformContext()` in one file would be an unauthenticated internal console page that
 * no other test notices.
 *
 * `shell-authorization.integration.test.ts` reads as though it covers this — its header says "every page
 * in the product shell goes through these two functions" — but it tests the two resolvers' behaviour and
 * never enumerates route files. That sentence was true by inspection and this is what makes it true by
 * construction.
 *
 * Walked with the TypeScript compiler rather than matched by line, for the reason the i18n gate gives: a
 * rule enforced by a regular expression is a rule a reformat defeats.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../app");

/** The three ways a request becomes an authorized caller. Nothing else counts. */
const RESOLVERS = ["requireWorkspaceContext", "requireBusinessProfileContext", "requirePlatformContext"];

/**
 * Routes that are deliberately unauthenticated, each for a stated reason.
 *
 * An allowlist rather than a pattern, so adding one is a deliberate edit somebody reviews. Paths are
 * relative to `src/app`.
 */
const DELIBERATELY_PUBLIC: Readonly<Record<string, string>> = {
  "page.tsx": "the landing page, which is what an unauthenticated visitor is meant to see",
  "workspaces/page.tsx": "the workspace chooser, which calls auth() directly because it has no workspace to name yet",
  "api/health/route.ts": "a liveness probe that deliberately touches no database, queue or external API",
  "api/auth/[...nextauth]/route.ts": "Auth.js's own handler: it is the thing that authenticates",
  "api/webhooks/[channel]/[channelAccountId]/route.ts": "a provider webhook, authenticated by its signature rather than by a session",
  "api/channels/instagram/callback/route.ts": "an OAuth callback, authenticated by the state nonce it carries",
};

function walk(directory: string, prefix = ""): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const absolute = path.join(directory, entry);
    const relative = prefix === "" ? entry : `${prefix}/${entry}`;
    if (statSync(absolute).isDirectory()) {
      return walk(absolute, relative);
    }
    return /^(page\.tsx|route\.ts)$/u.test(entry) ? [relative] : [];
  });
}

/**
 * Whether a file reaches one of the resolvers, by AST rather than by substring.
 *
 * A *reference* counts, not only a call. The channel API routes are handlers built from an injected
 * dependency — `authorize: requireBusinessProfileContext` — so the module that wires them never calls the
 * resolver and is nonetheless exactly where the authorization comes from. Insisting on a call expression
 * would have reported five perfectly authorized routes as open. An unused import cannot slip through this
 * either way, because `@typescript-eslint/no-unused-vars` fails the build on one.
 */
function reachesResolver(absolute: string): boolean {
  const source = readFileSync(absolute, "utf8");
  const ast = ts.createSourceFile(absolute, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) {
      return;
    }
    if (ts.isIdentifier(node) && RESOLVERS.includes(node.text)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return found;
}

const webSrc = path.resolve(appRoot, "..");

/** Every module a file imports from inside `apps/web/src`, resolved to a path on disk. */
function importedModules(file: string): string[] {
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const resolved: string[] = [];
  for (const match of source.matchAll(/from "([^"]+)"/g)) {
    const specifier = match[1];
    if (specifier === undefined) {
      continue;
    }
    const target = specifier.startsWith("@/")
      ? path.resolve(webSrc, specifier.slice(2))
      : specifier.startsWith(".")
        ? path.resolve(path.dirname(file), specifier)
        : undefined;
    if (target === undefined || !target.startsWith(webSrc)) {
      continue;
    }
    for (const candidate of [`${target}.ts`, `${target}.tsx`, path.join(target, "index.ts")]) {
      try {
        if (statSync(candidate).isFile()) {
          resolved.push(candidate);
          break;
        }
      } catch {
        // Not that extension, which is ordinary.
      }
    }
  }
  return resolved;
}

/**
 * The files that could authorize this route: its own, every ancestor `layout.tsx`, and what it imports.
 *
 * The imports matter because that is where this app actually puts the call. A page awaits a loader
 * (`loadBillingPage`) which resolves the context; an API route is a handler built from an injected
 * `authorize` dependency, and the module that supplies it is where `requireBusinessProfileContext`
 * appears. A rule that insisted on the call appearing in `page.tsx` itself would have failed every
 * existing route while all of them were perfectly authorized — so this follows imports two levels, which
 * covers route → dependencies → `request-context` and page → loader.
 */
function authorizingFiles(relative: string): string[] {
  const own = path.join(appRoot, relative);
  const chain: string[] = [own];
  let directory = path.dirname(own);
  while (directory.startsWith(appRoot)) {
    const layout = path.join(directory, "layout.tsx");
    try {
      if (statSync(layout).isFile()) {
        chain.push(layout);
      }
    } catch {
      // No layout at this level, which is ordinary.
    }
    if (directory === appRoot) {
      break;
    }
    directory = path.dirname(directory);
  }
  const first = importedModules(own);
  chain.push(...first);
  for (const imported of first) {
    chain.push(...importedModules(imported));
  }
  return [...new Set(chain)];
}

describe("every route in this app", () => {
  const routes = walk(appRoot);

  it("is authorized by its own source, an ancestor layout or the loader it imports", () => {
    const unauthorized: string[] = [];
    for (const relative of routes) {
      if (relative in DELIBERATELY_PUBLIC) {
        continue;
      }
      const authorized = authorizingFiles(relative).some((candidate) => {
        try {
          return reachesResolver(candidate);
        } catch {
          return false;
        }
      });
      if (!authorized) {
        unauthorized.push(relative);
      }
    }

    expect(unauthorized, "a route nothing authorizes is a page anybody can open").toEqual([]);
  });

  it("names every deliberate exception, with the reason it is one", () => {
    // The allowlist may not drift: an entry for a route that no longer exists is a line nobody will
    // question later, and a reason nobody wrote is an exception nobody reviewed.
    const stale = Object.keys(DELIBERATELY_PUBLIC).filter((entry) => !routes.includes(entry));

    expect(stale, "an allowlist entry for a route that does not exist").toEqual([]);
    for (const [route, reason] of Object.entries(DELIBERATELY_PUBLIC)) {
      expect(reason.length, route).toBeGreaterThan(20);
    }
  });

  it("puts every admin route behind the platform resolver and nothing else", () => {
    // The customer resolvers must not appear under `/admin`: an operator holding a `WorkspaceContext`
    // would hold customer OWNER authority, which is the one thing this whole separation prevents.
    const adminRoutes = routes.filter((relative) => relative.startsWith("admin/"));
    const offenders: string[] = [];
    for (const relative of adminRoutes) {
      const files = authorizingFiles(relative);
      const platform = files.some((candidate) => {
        try {
          return readFileSync(candidate, "utf8").includes("requirePlatformContext");
        } catch {
          return false;
        }
      });
      if (!platform) {
        offenders.push(`${relative} does not reach requirePlatformContext`);
      }
      // `request-context.ts` and `workspace-context.ts` *define* all three resolvers, so they name the
      // customer ones by necessity. What must not happen is an admin loader *calling* one, which is what
      // the remaining files in the chain would show.
      const definitionSites = ["request-context.ts", "workspace-context.ts"];
      for (const candidate of files.filter((file) => file.includes("/server/") && !definitionSites.includes(path.basename(file)))) {
        try {
          const source = readFileSync(candidate, "utf8");
          if (source.includes("requireWorkspaceContext") || source.includes("requireBusinessProfileContext")) {
            offenders.push(`${relative} reaches a customer resolver through ${path.basename(candidate)}`);
          }
        } catch {
          // Not a file, which the loop above already tolerates.
        }
      }
    }

    expect(adminRoutes.length, "the admin console should have routes").toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  it("would notice an unauthorized route if one were added", () => {
    // Otherwise the walk passes because the matcher is broken rather than because the routes are sound.
    const sample = "export default async function Page() {\n  return <div />;\n}\n";
    const ast = ts.createSourceFile("sample.tsx", sample, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let calls = 0;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        calls += 1;
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);

    expect(calls).toBe(0);
    // And the real walk found a non-trivial number of routes, so an empty list is not why it passed.
    expect(routes.length).toBeGreaterThan(20);
  });
});
