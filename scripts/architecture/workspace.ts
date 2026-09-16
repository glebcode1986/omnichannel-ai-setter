import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import ts from "typescript";

import { DEPENDENCY_FIELDS, type SourceFile, type WorkspacePackage } from "./check.ts";

const SOURCE_EXTENSIONS = /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/;
const IGNORED_DIRECTORIES = new Set(["node_modules", "dist", "out", "coverage", "build"]);

interface Manifest {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

async function readManifest(file: string): Promise<Manifest> {
  return JSON.parse(await readFile(file, "utf8")) as Manifest;
}

/**
 * Reads `packages:` globs from pnpm-workspace.yaml. Only `<dir>/*` globs are supported, which is
 * what the repository layout uses; anything else fails loudly rather than being silently skipped.
 */
export async function readWorkspaceGlobs(rootDir: string): Promise<string[]> {
  const yaml = await readFile(path.join(rootDir, "pnpm-workspace.yaml"), "utf8");
  const globs: string[] = [];
  let inPackages = false;
  for (const rawLine of yaml.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trimEnd();
    if (line.trim() === "") {
      continue;
    }
    if (!line.startsWith(" ") && !line.startsWith("-")) {
      inPackages = line === "packages:";
      continue;
    }
    const entry = /^\s*-\s*["']?([^"']+)["']?\s*$/.exec(line)?.[1];
    if (inPackages && entry) {
      if (!/^[\w.-]+\/\*$/.test(entry)) {
        throw new Error(`Unsupported pnpm workspace glob "${entry}"; extend scripts/architecture/workspace.ts.`);
      }
      globs.push(entry);
    }
  }
  if (globs.length === 0) {
    throw new Error("pnpm-workspace.yaml declares no packages.");
  }
  return globs;
}

async function collectSourceFiles(packageDir: string, relativeDir = ""): Promise<SourceFile[]> {
  const entries = await readdir(path.join(packageDir, relativeDir), { withFileTypes: true });
  const files: SourceFile[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name) && !entry.name.startsWith(".")) {
        files.push(...(await collectSourceFiles(packageDir, relativePath)));
      }
    } else if (entry.isFile() && SOURCE_EXTENSIONS.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name)) {
      const text = await readFile(path.join(packageDir, relativePath), "utf8");
      files.push({ path: relativePath, imports: extractImports(text) });
    }
  }
  return files;
}

/** Static import/export/require/dynamic-import specifiers, via the TypeScript pre-processor. */
export function extractImports(sourceText: string): string[] {
  const { importedFiles } = ts.preProcessFile(sourceText, true, true);
  return importedFiles.map((importedFile) => importedFile.fileName);
}

export async function loadWorkspace(rootDir: string): Promise<{
  packages: WorkspacePackage[];
  rootDevDependencies: string[];
}> {
  const rootManifest = await readManifest(path.join(rootDir, "package.json"));
  const packages: WorkspacePackage[] = [];

  for (const glob of await readWorkspaceGlobs(rootDir)) {
    const parent = glob.slice(0, -2);
    const entries = await readdir(path.join(rootDir, parent), { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) {
        continue;
      }
      const dir = `${parent}/${entry.name}`;
      const manifest = await readManifest(path.join(rootDir, dir, "package.json")).catch(() => undefined);
      if (!manifest) {
        continue;
      }
      if (!manifest.name) {
        throw new Error(`${dir}/package.json has no "name".`);
      }
      packages.push({
        name: manifest.name,
        dir,
        manifest: Object.fromEntries(
          DEPENDENCY_FIELDS.flatMap((field) => (manifest[field] ? [[field, manifest[field]]] : [])),
        ),
        sourceFiles: await collectSourceFiles(path.join(rootDir, dir)),
      });
    }
  }

  return { packages, rootDevDependencies: Object.keys(rootManifest.devDependencies ?? {}) };
}
