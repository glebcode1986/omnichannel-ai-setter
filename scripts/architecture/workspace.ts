import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import ts from "typescript";

import {
  DEPENDENCY_FIELDS,
  type Manifest,
  type ModuleAlias,
  type RootWorkspace,
  type SourceFile,
  type WorkspacePackage,
} from "./check.ts";

const SOURCE_FILE = /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/;
/** Build/tool output directories, skipped only at the top level of a package. */
const TOP_LEVEL_OUTPUT_DIRECTORIES = new Set(["dist", "out", "build", "coverage"]);
/** Generated declaration files that are not hand-written source. */
const GENERATED_FILES = new Set(["next-env.d.ts"]);

interface RawManifest {
  name?: string;
  imports?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

/** Reads a manifest; returns `undefined` only when it does not exist. Malformed JSON fails loudly. */
async function readManifest(file: string): Promise<RawManifest | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw error;
  }
  try {
    return JSON.parse(text) as RawManifest;
  } catch (error) {
    throw new Error(`Cannot parse ${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function dependencyFields(manifest: RawManifest): Manifest {
  return Object.fromEntries(DEPENDENCY_FIELDS.flatMap((field) => (manifest[field] ? [[field, manifest[field]]] : [])));
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
      inPackages = line.trim() === "packages:";
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

function scriptKindFor(fileName: string): ts.ScriptKind {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * Module specifiers from an AST walk: import/export declarations (including `export * as ns`),
 * `import x = require()`, dynamic `import()`, `require()`/`require.resolve()`, `import("x").T`
 * type queries and `/// <reference path>` targets. Text inside strings/JSX is never matched.
 */
export function extractModuleReferences(
  sourceText: string,
  fileName = "file.ts",
): { imports: string[]; typeReferences: string[] } {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));
  const imports: string[] = sourceFile.referencedFiles.map((reference) => reference.fileName);
  const typeReferences = sourceFile.typeReferenceDirectives.map((reference) => reference.fileName);

  const addLiteral = (node: ts.Node | undefined) => {
    if (node && ts.isStringLiteralLike(node)) {
      imports.push(node.text);
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addLiteral(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      addLiteral(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      addLiteral(node.argument.literal);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      const isRequireResolve =
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "require" &&
        callee.name.text === "resolve";
      if (isDynamicImport || isRequire || isRequireResolve) {
        addLiteral(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return { imports, typeReferences };
}

async function collectSourceFiles(
  baseDir: string,
  options: { topLevelSkip: ReadonlySet<string> },
  relativeDir = "",
): Promise<{ files: SourceFile[]; symlinks: string[] }> {
  const entries = await readdir(path.join(baseDir, relativeDir), { withFileTypes: true });
  const files: SourceFile[] = [];
  const symlinks: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.name === "node_modules" || (relativeDir === "" && (entry.name.startsWith(".") || options.topLevelSkip.has(entry.name)))) {
      continue;
    }
    if (entry.isSymbolicLink()) {
      symlinks.push(relativePath);
    } else if (entry.isDirectory()) {
      const nested = await collectSourceFiles(baseDir, options, relativePath);
      files.push(...nested.files);
      symlinks.push(...nested.symlinks);
    } else if (entry.isFile() && SOURCE_FILE.test(entry.name) && !(relativeDir === "" && GENERATED_FILES.has(entry.name))) {
      const text = await readFile(path.join(baseDir, relativePath), "utf8");
      files.push({ path: relativePath, ...extractModuleReferences(text, entry.name) });
    }
  }
  return { files, symlinks };
}

function toPackageRelative(packageDir: string, absoluteTarget: string): string {
  const relative = path.relative(packageDir, absoluteTarget).split(path.sep).join("/");
  return relative.startsWith("..") ? relative : `./${relative}`;
}

/** Effective tsconfig `types` and `paths` (following `extends`), with path targets made package-relative. */
function readTsconfig(packageDir: string): { types?: string[]; aliases: ModuleAlias[] } {
  const configFile = path.join(packageDir, "tsconfig.json");
  if (!ts.sys.fileExists(configFile)) {
    return { aliases: [] };
  }
  const result = ts.readConfigFile(configFile, (file) => ts.sys.readFile(file));
  if (result.error) {
    throw new Error(`Cannot read ${configFile}: ${ts.flattenDiagnosticMessageText(result.error.messageText, "\n")}`);
  }
  const config: unknown = result.config;
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, packageDir, undefined, configFile);
  const options = parsed.options as ts.CompilerOptions & { pathsBasePath?: string };
  const basePath = options.pathsBasePath ?? packageDir;
  const aliases = Object.entries(options.paths ?? {}).map(([pattern, targets]) => ({
    pattern,
    targets: targets.map((target) => toPackageRelative(packageDir, path.resolve(basePath, target))),
  }));
  return { ...(options.types ? { types: options.types } : {}), aliases };
}

/** package.json `imports` (subpath imports), flattening conditional targets. */
function readSubpathImports(manifest: RawManifest): ModuleAlias[] {
  const leaves = (value: unknown): string[] => {
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) return value.flatMap(leaves);
    if (value && typeof value === "object") return Object.values(value).flatMap(leaves);
    return [];
  };
  return Object.entries(manifest.imports ?? {}).map(([pattern, value]) => ({ pattern, targets: leaves(value) }));
}

export async function loadWorkspace(rootDir: string): Promise<{ packages: WorkspacePackage[]; root: RootWorkspace }> {
  const rootManifest = await readManifest(path.join(rootDir, "package.json"));
  if (!rootManifest) {
    throw new Error(`No package.json found in ${rootDir}.`);
  }
  const packages: WorkspacePackage[] = [];

  for (const glob of await readWorkspaceGlobs(rootDir)) {
    const parent = glob.slice(0, -2);
    let entries;
    try {
      entries = await readdir(path.join(rootDir, parent), { withFileTypes: true });
    } catch (error) {
      if (isMissingFile(error)) continue;
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) {
        continue;
      }
      const dir = `${parent}/${entry.name}`;
      const packageDir = path.join(rootDir, dir);
      const manifest = await readManifest(path.join(packageDir, "package.json"));
      if (!manifest) {
        continue;
      }
      if (!manifest.name) {
        throw new Error(`${dir}/package.json has no "name".`);
      }
      const tsconfig = readTsconfig(packageDir);
      const { files, symlinks } = await collectSourceFiles(packageDir, { topLevelSkip: TOP_LEVEL_OUTPUT_DIRECTORIES });
      packages.push({
        name: manifest.name,
        dir,
        manifest: dependencyFields(manifest),
        sourceFiles: files,
        symlinks,
        ...(tsconfig.types ? { tsconfigTypes: tsconfig.types } : {}),
        aliases: [...readSubpathImports(manifest), ...tsconfig.aliases],
      });
    }
  }

  const scripts = await collectSourceFiles(path.join(rootDir, "scripts"), { topLevelSkip: new Set() }).catch(
    (error: unknown) => {
      if (isMissingFile(error)) return { files: [], symlinks: [] };
      throw error;
    },
  );

  return {
    packages,
    root: {
      manifest: dependencyFields(rootManifest),
      sourceFiles: scripts.files.map((file) => ({ ...file, path: `scripts/${file.path}` })),
    },
  };
}
