import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import ts from "typescript";

import {
  DEPENDENCY_FIELDS,
  TOP_LEVEL_OUTPUT_DIRECTORIES,
  type Manifest,
  type ModuleAlias,
  type RootWorkspace,
  type SourceFile,
  type WorkspacePackage,
} from "./check.ts";

const SOURCE_FILE = /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/;
/** Generated declaration files that are not hand-written source. */
const GENERATED_FILES = new Set(["next-env.d.ts"]);

interface RawManifest {
  name?: string;
  imports?: Record<string, unknown>;
  exports?: unknown;
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

/** Folds string literals, `+` concatenations and templates whose parts are all constant. */
function foldConstantString(node: ts.Expression): string | undefined {
  if (ts.isStringLiteralLike(node)) {
    return node.text;
  }
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return foldConstantString(node.expression);
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = foldConstantString(node.left);
    const right = left === undefined ? undefined : foldConstantString(node.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    for (const span of node.templateSpans) {
      const part = foldConstantString(span.expression);
      if (part === undefined) {
        return undefined;
      }
      text += part + span.literal.text;
    }
    return text;
  }
  return undefined;
}

export interface ModuleReferences {
  imports: string[];
  typeReferences: string[];
  /** Source text of module-loading calls whose target is not a compile-time constant. */
  unresolvedModuleLoads: string[];
}

/**
 * Module specifiers from an AST walk: import/export declarations (including `export * as ns`),
 * `import x = require()`, dynamic `import()`, `require()`/`require.resolve()`/`module.require()`,
 * `process.getBuiltinModule()`, `import("x").T` type queries and `/// <reference path>` targets.
 * Text inside strings/JSX is never matched. Loader calls with computed targets are folded when
 * constant and otherwise reported, so the gate fails closed instead of silently skipping them.
 */
export function extractModuleReferences(sourceText: string, fileName = "file.ts"): ModuleReferences {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));
  const imports: string[] = sourceFile.referencedFiles.map((reference) => reference.fileName);
  const typeReferences = sourceFile.typeReferenceDirectives.map((reference) => reference.fileName);
  const unresolvedModuleLoads: string[] = [];

  const addLiteral = (node: ts.Node | undefined) => {
    if (node && ts.isStringLiteralLike(node)) {
      imports.push(node.text);
    }
  };

  const addLoaderTarget = (call: ts.CallExpression) => {
    const argument = call.arguments[0];
    const folded = argument && !ts.isSpreadElement(argument) ? foldConstantString(argument) : undefined;
    if (folded === undefined) {
      unresolvedModuleLoads.push(call.getText(sourceFile).slice(0, 120));
    } else {
      imports.push(folded);
    }
  };

  const isNamedCall = (callee: ts.Expression, object: string, method: string): boolean =>
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === object &&
    callee.name.text === method;

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addLiteral(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      addLiteral(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      addLiteral(node.argument.literal);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === "require") ||
        isNamedCall(callee, "require", "resolve") ||
        isNamedCall(callee, "module", "require")
      ) {
        addLoaderTarget(node);
      } else if (isNamedCall(callee, "process", "getBuiltinModule")) {
        const folded = node.arguments[0] ? foldConstantString(node.arguments[0]) : undefined;
        if (folded === undefined) {
          unresolvedModuleLoads.push(node.getText(sourceFile).slice(0, 120));
        } else {
          imports.push(folded.startsWith("node:") ? folded : `node:${folded}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return { imports, typeReferences, unresolvedModuleLoads };
}

async function collectSourceFiles(
  baseDir: string,
  options: { topLevelSkip: ReadonlySet<string> },
  relativeDir = "",
): Promise<{ files: SourceFile[]; symlinks: string[]; nestedManifests: string[] }> {
  const entries = await readdir(path.join(baseDir, relativeDir), { withFileTypes: true });
  const files: SourceFile[] = [];
  const symlinks: string[] = [];
  const nestedManifests: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    // Before any name-based skip: a symlink called node_modules/dist/.shared is still a symlink.
    if (entry.isSymbolicLink()) {
      symlinks.push(relativePath);
      continue;
    }
    if (entry.name === "node_modules" || (relativeDir === "" && (entry.name.startsWith(".") || options.topLevelSkip.has(entry.name)))) {
      continue;
    }
    if (entry.isDirectory()) {
      const nested = await collectSourceFiles(baseDir, options, relativePath);
      files.push(...nested.files);
      symlinks.push(...nested.symlinks);
      nestedManifests.push(...nested.nestedManifests);
    } else if (entry.isFile() && entry.name === "package.json" && relativeDir !== "") {
      // A nested manifest turns a directory into a package with its own `main`/`exports`.
      nestedManifests.push(relativePath);
    } else if (entry.isFile() && SOURCE_FILE.test(entry.name) && !(relativeDir === "" && GENERATED_FILES.has(entry.name))) {
      const text = await readFile(path.join(baseDir, relativePath), "utf8");
      files.push({ path: relativePath, ...extractModuleReferences(text, entry.name) });
    }
  }
  return { files, symlinks, nestedManifests };
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
  // TypeScript resolves `paths` against `baseUrl` when set, otherwise against the config declaring them.
  const basePath = options.baseUrl ?? options.pathsBasePath ?? packageDir;
  const aliases = Object.entries(options.paths ?? {}).map(([pattern, targets]) => ({
    pattern,
    targets: targets.map((target) => toPackageRelative(packageDir, path.resolve(basePath, target))),
  }));
  return { ...(options.types ? { types: options.types } : {}), aliases };
}

/** String leaves of a conditional package.json target (`null` exclusions are dropped). */
function targetLeaves(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(targetLeaves);
  if (value && typeof value === "object") return Object.values(value).flatMap(targetLeaves);
  return [];
}

/** package.json `imports` (subpath imports), flattening conditional targets. */
function readSubpathImports(manifest: RawManifest): ModuleAlias[] {
  return Object.entries(manifest.imports ?? {}).map(([pattern, value]) => ({ pattern, targets: targetLeaves(value) }));
}

/** package.json `exports` as self-reference aliases (`@scope/pkg/sub` -> target) plus every target. */
function readExports(manifest: RawManifest & { name: string }): { aliases: ModuleAlias[]; targets: string[] } {
  const exportsField = manifest.exports;
  if (exportsField === undefined || exportsField === null) {
    return { aliases: [], targets: [] };
  }
  const isSubpathMap =
    typeof exportsField === "object" && !Array.isArray(exportsField) && Object.keys(exportsField).some((key) => key.startsWith("."));
  const entries: [string, unknown][] = isSubpathMap ? Object.entries(exportsField) : [[".", exportsField]];
  const aliases = entries.map(([subpath, value]) => ({
    pattern: subpath === "." ? manifest.name : `${manifest.name}/${subpath.replace(/^\.\//, "")}`,
    targets: targetLeaves(value),
  }));
  return { aliases, targets: aliases.flatMap((alias) => alias.targets) };
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
      const exportsInfo = readExports({ ...manifest, name: manifest.name });
      const { files, symlinks, nestedManifests } = await collectSourceFiles(packageDir, {
        topLevelSkip: TOP_LEVEL_OUTPUT_DIRECTORIES,
      });
      packages.push({
        name: manifest.name,
        dir,
        manifest: dependencyFields(manifest),
        sourceFiles: files,
        symlinks,
        nestedManifests,
        exportTargets: exportsInfo.targets,
        ...(tsconfig.types ? { tsconfigTypes: tsconfig.types } : {}),
        aliases: [...readSubpathImports(manifest), ...exportsInfo.aliases, ...tsconfig.aliases],
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
