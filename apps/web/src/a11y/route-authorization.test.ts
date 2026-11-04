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

/**
 * The ways a request becomes an authorized caller. Nothing else counts.
 *
 * Six names, three authorizations: each `page*` entry is the page-render flavour of the `require*` above
 * it, differing only in that an unauthenticated visitor is redirected to sign-in instead of reaching a
 * throw that became an HTTP 500. `page-context.ts delegates` below asserts that equivalence by AST, so
 * these three are not an enlargement of the rule — remove the delegation and that test fails.
 *
 * `requireSessionUserId` and its `pageSessionUserId` flavour are deliberately absent, for the reason
 * `requireSessionUser`'s own header gives: knowing who you are is not being told what you may read.
 */
const RESOLVERS = [
  "requireWorkspaceContext",
  "requireBusinessProfileContext",
  "requirePlatformContext",
  "pageWorkspaceContext",
  "pageBusinessProfileContext",
  "pagePlatformContext",
];

/** The three authorizing page wrappers, each paired with the resolver it must delegate to. */
const PAGE_DELEGATIONS: Readonly<Record<string, string>> = {
  pageWorkspaceContext: "requireWorkspaceContext",
  pageBusinessProfileContext: "requireBusinessProfileContext",
  pagePlatformContext: "requirePlatformContext",
  pageSessionUserId: "requireSessionUserId",
};

/**
 * Routes that are deliberately unauthenticated, each for a stated reason.
 *
 * An allowlist rather than a pattern, so adding one is a deliberate edit somebody reviews. Paths are
 * relative to `src/app`.
 */
const DELIBERATELY_PUBLIC: Readonly<Record<string, string>> = {
  "page.tsx": "the landing page, which is what an unauthenticated visitor is meant to see",
  "workspaces/page.tsx":
    "the workspace chooser and the form that creates the first workspace: it authenticates with requireSessionUserId() and can name no workspace yet, because the thing a WorkspaceContext authorizes does not exist until that form is submitted",
  "sign-in/page.tsx":
    "the public sign-in and registration page: it is what somebody with no account reaches, it authorizes nothing and reads no tenant data, and the thing a WorkspaceContext would authorize does not exist for its reader yet",
  "sign-in/sent/page.tsx":
    "the page that says a one-time link was sent, reached by the same person before they have any session at all; it renders one sentence and reads nothing",
  "privacy/page.tsx":
    "the published Privacy Policy: a legal document is written for the people who have no account, it is linked from the landing page's footer, and it reads a committed text file rather than any tenant data",
  "terms/page.tsx":
    "the published Terms of Service, public for the same reason as the Privacy Policy and reading the same kind of committed text file",
  "api/health/route.ts": "a liveness probe that deliberately touches no database, queue or external API",
  "api/auth/[...nextauth]/route.ts": "Auth.js's own handler: it is the thing that authenticates",
  "api/webhooks/[channel]/[channelAccountId]/route.ts": "a provider webhook, authenticated by its signature rather than by a session",
  "api/billing/webhooks/stripe/route.ts":
    "a billing provider's webhook, authenticated by the signing secret of the endpoint it arrived on; there is no session, and the route records nothing it did not first verify through the provider port",
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
/**
 * The three modules that *define* the resolvers, which therefore name all of them by necessity.
 *
 * `page-context.ts` joins the two originals for exactly their reason. It names every `require*` because
 * it wraps every one of them, so a page that imported only `pageSessionUserId` — authentication, which
 * authorizes nothing — would otherwise satisfy the walk by *reaching the file where the resolvers are
 * named*. That is the same hole `requireSessionUserId` opened in `request-context.ts`, reopened one
 * module along, and it is closed the same way.
 *
 * Excluded from every chain, because merely importing one proves nothing (#115). `request-context.ts`
 * gained `requireSessionUserId` — an authentication-only helper the workspace chooser and the
 * create-workspace action legitimately need, since neither has a Workspace to name — and from that moment
 * a page that imported it would have satisfied this walk by *reaching the file where the resolvers live*,
 * without authorizing anything. The admin assertion below already treated these two as definition sites
 * for the same reason; this applies it to every route.
 *
 * Nothing legitimate loses its authorization to this. A page that calls a resolver names it in its own
 * source — the import declaration alone puts the identifier in that file's AST — and a page that defers
 * to a loader names it in the loader, which is a different file either way.
 */
const DEFINITION_SITES = ["request-context.ts", "workspace-context.ts", "page-context.ts"];

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
  return [...new Set(chain)].filter((file) => file === own || !DEFINITION_SITES.includes(path.basename(file)));
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
      // Either flavour of the platform resolver: the page wrapper authorizes identically and differs only
      // in where it sends somebody who is not signed in.
      const platform = files.some((candidate) => {
        try {
          const source = readFileSync(candidate, "utf8");
          return source.includes("requirePlatformContext") || source.includes("pagePlatformContext");
        } catch {
          return false;
        }
      });
      if (!platform) {
        offenders.push(`${relative} does not reach the platform resolver`);
      }
      // The definition sites *name* every resolver, so they name the customer ones by necessity. What must
      // not happen is an admin loader *calling* one, which is what the remaining files in the chain would
      // show. Both flavours are forbidden here for the same reason: an operator holding a customer context
      // holds customer OWNER authority however they were redirected on the way in.
      for (const candidate of files.filter((file) => file.includes("/server/") && !DEFINITION_SITES.includes(path.basename(file)))) {
        try {
          const source = readFileSync(candidate, "utf8");
          const customer = ["requireWorkspaceContext", "requireBusinessProfileContext", "pageWorkspaceContext", "pageBusinessProfileContext"];
          if (customer.some((name) => source.includes(name))) {
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

  /**
   * The page wrappers are in `RESOLVERS` only because they delegate. This is what makes that true by
   * construction rather than by the name looking similar: each one must name its counterpart inside its
   * own body, so a wrapper rewritten to resolve the context itself — or to return a context without
   * authorizing anybody — stops satisfying the rule it was admitted under.
   */
  it("page-context.ts delegates every wrapper to the resolver of the same meaning", () => {
    const file = path.resolve(webSrc, "server/page-context.ts");
    const ast = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    const bodies = new Map<string, string>();
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name !== undefined && node.body !== undefined) {
        bodies.set(node.name.text, node.body.getText(ast));
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);

    const missing = Object.entries(PAGE_DELEGATIONS)
      .filter(([wrapper, resolver]) => !(bodies.get(wrapper) ?? "").includes(resolver))
      .map(([wrapper, resolver]) => `${wrapper} does not call ${resolver}`);

    expect(missing, "a page wrapper that does not delegate is a second authorization rule").toEqual([]);
    // The matcher found the functions at all — otherwise an empty map would pass the check above vacuously.
    expect([...bodies.keys()]).toEqual(expect.arrayContaining(Object.keys(PAGE_DELEGATIONS)));
  });
});
