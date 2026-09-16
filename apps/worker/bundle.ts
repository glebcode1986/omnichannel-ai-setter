/**
 * Bundles the worker into a single ESM file so production runs plain `node` without a TS loader.
 *
 * Workspace packages (`@omnichannel/*`) export TypeScript source, so they are always bundled.
 * Third-party packages listed in this app's `dependencies` stay external and are resolved from
 * `node_modules` at runtime. Anything else reachable only through workspace packages is bundled.
 *
 * Declare a dependency in apps/worker `dependencies` (with the same range the owning package uses;
 * `pnpm lint:boundaries` enforces equal ranges) when it is native/wasm-heavy (Prisma, BullMQ) or
 * reads files relative to its own location (`__dirname`, `__filename`, bundled assets) — such
 * packages break when inlined into dist/.
 */
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import { build, type Plugin } from "esbuild";

const WORKSPACE_SCOPE = "@omnichannel/";
const appDir = import.meta.dirname;

export interface BundleWorkerOptions {
  /** Output directory; must be inside apps/worker so external dependencies resolve. */
  outDir: string;
  logLevel?: "silent" | "error" | "warning" | "info";
}

function packageNameOf(specifier: string): string {
  const [first = "", second = ""] = specifier.split("/");
  return specifier.startsWith("@") ? `${first}/${second}` : first;
}

export async function bundleWorker({ outDir, logLevel = "info" }: BundleWorkerOptions): Promise<string> {
  const manifest = JSON.parse(await readFile(path.join(appDir, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const externalDependencies = new Set(
    Object.keys(manifest.dependencies ?? {}).filter((name) => !name.startsWith(WORKSPACE_SCOPE)),
  );

  const externalizeDeclaredDependencies: Plugin = {
    name: "externalize-declared-dependencies",
    setup(pluginBuild) {
      // Bare module specifiers only; relative and absolute paths are always bundled.
      pluginBuild.onResolve({ filter: /^[^./]/ }, (args) =>
        externalDependencies.has(packageNameOf(args.path)) ? { path: args.path, external: true } : undefined,
      );
    },
  };

  const outfile = path.join(outDir, "main.js");
  await rm(outDir, { recursive: true, force: true });
  await build({
    entryPoints: [path.join(appDir, "src/main.ts")],
    outfile,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    sourcemap: true,
    logLevel,
    plugins: [externalizeDeclaredDependencies],
    // Bundled CommonJS code calls `require`, which ESM output lacks. esbuild renames bundled
    // top-level `require` bindings, and the alias is namespaced to avoid colliding with bundled code.
    banner: {
      js: 'import { createRequire as __omnichannelBundleCreateRequire } from "node:module"; const require = __omnichannelBundleCreateRequire(import.meta.url);',
    },
  });
  return outfile;
}
