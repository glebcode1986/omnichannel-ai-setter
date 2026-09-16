/**
 * Bundles the worker into `dist/main.js` so production runs plain `node` without a TS loader.
 *
 * Workspace packages (`@omnichannel/*`) export TypeScript source, so they are always bundled.
 * Third-party packages declared in this app's `dependencies` stay external and are resolved from
 * `node_modules` at runtime (declare native/wasm-heavy libraries such as Prisma or BullMQ there);
 * anything else reachable only through workspace packages is bundled.
 */
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import { build, type Plugin } from "esbuild";

const WORKSPACE_SCOPE = "@omnichannel/";
const appDir = import.meta.dirname;
const outDir = path.join(appDir, "dist");

const manifest = JSON.parse(await readFile(path.join(appDir, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
};
const externalDependencies = new Set(
  Object.keys(manifest.dependencies ?? {}).filter((name) => !name.startsWith(WORKSPACE_SCOPE)),
);

function packageNameOf(specifier: string): string {
  const [first = "", second = ""] = specifier.split("/");
  return specifier.startsWith("@") ? `${first}/${second}` : first;
}

const externalizeDeclaredDependencies: Plugin = {
  name: "externalize-declared-dependencies",
  setup(pluginBuild) {
    // Bare module specifiers only; relative and absolute paths are always bundled.
    pluginBuild.onResolve({ filter: /^[^./]/ }, (args) =>
      externalDependencies.has(packageNameOf(args.path)) ? { path: args.path, external: true } : undefined,
    );
  },
};

await rm(outDir, { recursive: true, force: true });

await build({
  entryPoints: [path.join(appDir, "src/main.ts")],
  outfile: path.join(outDir, "main.js"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: true,
  logLevel: "info",
  plugins: [externalizeDeclaredDependencies],
  // Bundled CommonJS dependencies may call `require`; ESM output has no global `require`.
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});
