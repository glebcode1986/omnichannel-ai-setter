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
 * Well-known module-loading objects, tracked through aliases the analysis can follow:
 * - `require`: the CommonJS `require` (also `module.require`, `globalThis.require`);
 * - `loader`: a `createRequire(...)` result bound to a local name;
 * - `resolver`: `require.resolve` / `<loader>.resolve`;
 * - `builtin`: `process.getBuiltinModule`;
 * - `createRequire`: `createRequire` under any imported/destructured name or as `<anything>.createRequire`;
 * - `process`, `module`, `moduleNamespace` (an import of `module`/`node:module`), `global` (`globalThis`/`global`).
 */
type KnownObject = "require" | "loader" | "resolver" | "builtin" | "createRequire" | "process" | "module" | "moduleNamespace" | "global";

const NODE_MODULE_SPECIFIERS: ReadonlySet<string> = new Set(["module", "node:module"]);

/** Members that turn a known object into another known (loader-related) object. */
const SENSITIVE_MEMBERS: Readonly<Record<KnownObject, ReadonlySet<string>>> = {
  require: new Set(["resolve", "call", "apply", "bind"]),
  loader: new Set(["resolve", "call", "apply", "bind"]),
  resolver: new Set(["call", "apply", "bind"]),
  builtin: new Set(["call", "apply", "bind"]),
  createRequire: new Set(["call", "apply", "bind"]),
  process: new Set(["getBuiltinModule"]),
  module: new Set(["require", "createRequire"]),
  moduleNamespace: new Set(["createRequire", "default"]),
  global: new Set(["process", "module", "require"]),
};

/** Kinds whose direct invocation loads (or resolves) a module named by the first argument. */
const LOADING_KINDS: ReadonlySet<KnownObject> = new Set(["require", "loader", "resolver"]);

/**
 * Module specifiers from an AST walk: import/export declarations (including `export * as ns`),
 * `import x = require()`, dynamic `import()`, `require()`/`require.resolve()`/`module.require()`,
 * `process.getBuiltinModule()`, `createRequire` loaders, `import("x").T` type queries and
 * `/// <reference path>` targets. Text inside strings/JSX is never matched.
 *
 * Fail-closed policy: loader targets must fold to constants, and module-loading objects may only be
 * used by direct call or plain (non-loader) member reads. Member names are normalized across `a.b`,
 * `a["b"]` and constant templates; computed member access on a loader-related object, aliasing,
 * storing, passing, exporting or destructuring loader members are all reported as unresolved loads.
 * Matching is by name within a file, so reusing a loader's name for something else is reported too.
 */
export function extractModuleReferences(sourceText: string, fileName = "file.ts"): ModuleReferences {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));
  const imports: string[] = sourceFile.referencedFiles.map((reference) => reference.fileName);
  const typeReferences = sourceFile.typeReferenceDirectives.map((reference) => reference.fileName);
  const unresolvedModuleLoads: string[] = [];
  const snippet = (node: ts.Node) => node.getText(sourceFile).slice(0, 120);

  const isWrapper = (node: ts.Node | undefined): node is ts.ParenthesizedExpression | ts.AsExpression | ts.NonNullExpression | ts.SatisfiesExpression | ts.TypeAssertion =>
    node !== undefined &&
    (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node));
  const unwrap = (expression: ts.Expression): ts.Expression => {
    let current = expression;
    while (isWrapper(current)) {
      current = current.expression;
    }
    return current;
  };
  const outermost = (node: ts.Node): ts.Node => {
    let current = node;
    while (isWrapper(current.parent)) {
      current = current.parent;
    }
    return current;
  };
  const isMemberAccess = (node: ts.Node): node is ts.PropertyAccessExpression | ts.ElementAccessExpression =>
    ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);
  const memberName = (node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined =>
    ts.isPropertyAccessExpression(node) ? node.name.text : foldConstantString(node.argumentExpression);
  const isNodeModuleSource = (expression: ts.Expression | undefined): boolean => {
    if (!expression) return false;
    const inner = unwrap(ts.isAwaitExpression(unwrap(expression)) ? (unwrap(expression) as ts.AwaitExpression).expression : expression);
    if (!ts.isCallExpression(inner)) return false;
    const callee = unwrap(inner.expression);
    const isLoaderCall = callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require");
    const target = inner.arguments[0] ? foldConstantString(inner.arguments[0]) : undefined;
    return isLoaderCall && target !== undefined && NODE_MODULE_SPECIFIERS.has(target);
  };

  // Names bound to createRequire, to an import of node:module, and to createRequire results.
  const createRequireNames = new Set<string>(["createRequire"]);
  const moduleNamespaceNames = new Set<string>();
  const loaderNames = new Set<string>();
  const collectNames = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier) && NODE_MODULE_SPECIFIERS.has(node.moduleSpecifier.text)) {
      const clause = node.importClause;
      if (clause?.name) moduleNamespaceNames.add(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) moduleNamespaceNames.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if ((element.propertyName ?? element.name).text === "createRequire") createRequireNames.add(element.name.text);
        }
      }
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const target = foldConstantString(node.moduleReference.expression);
      if (target !== undefined && NODE_MODULE_SPECIFIERS.has(target)) moduleNamespaceNames.add(node.name.text);
    }
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      const property = node.propertyName && ts.isIdentifier(node.propertyName) ? node.propertyName.text : node.name.text;
      if (property === "createRequire") createRequireNames.add(node.name.text);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && isNodeModuleSource(node.initializer)) {
      moduleNamespaceNames.add(node.name.text);
    }
    ts.forEachChild(node, collectNames);
  };
  collectNames(sourceFile);

  const known = (expression: ts.Expression): KnownObject | undefined => {
    const node = unwrap(expression);
    if (ts.isIdentifier(node)) {
      if (loaderNames.has(node.text)) return "loader";
      if (createRequireNames.has(node.text)) return "createRequire";
      if (moduleNamespaceNames.has(node.text)) return "moduleNamespace";
      switch (node.text) {
        case "require":
          return "require";
        case "process":
          return "process";
        case "module":
          return "module";
        case "globalThis":
        case "global":
          return "global";
        default:
          return undefined;
      }
    }
    if (isMemberAccess(node)) {
      const name = memberName(node);
      if (name === "createRequire") return "createRequire";
      const object = known(node.expression);
      if (object === "global" && (name === "process" || name === "module" || name === "require")) return name;
      if (object === "process" && name === "getBuiltinModule") return "builtin";
      if (object === "module" && name === "require") return "require";
      if (object === "moduleNamespace" && name === "default") return "moduleNamespace";
      if ((object === "require" || object === "loader") && name === "resolve") return "resolver";
      return undefined;
    }
    if (ts.isCallExpression(node) && known(node.expression) === "createRequire") {
      return "loader";
    }
    return undefined;
  };

  const collectLoaders = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = unwrap(node.initializer);
      if (ts.isCallExpression(initializer) && known(initializer.expression) === "createRequire") {
        loaderNames.add(node.name.text);
      }
    }
    ts.forEachChild(node, collectLoaders);
  };
  collectLoaders(sourceFile);

  const reportEscape = (node: ts.Node, what: string) => {
    const context = outermost(node).parent;
    unresolvedModuleLoads.push(`${what} used as a value: ${snippet(context ?? node)}`);
  };

  const addLoaderTarget = (call: ts.CallExpression) => {
    const argument = call.arguments[0];
    const folded = argument && !ts.isSpreadElement(argument) ? foldConstantString(argument) : undefined;
    if (folded === undefined) {
      unresolvedModuleLoads.push(snippet(call));
    } else {
      imports.push(folded);
    }
  };

  const isDeclarationName = (identifier: ts.Identifier): boolean => {
    const parent = identifier.parent;
    if (ts.isExportSpecifier(parent)) {
      // `export { local as exported }` introduces `exported`; `export { x } from "m"` references no local.
      return (parent.propertyName !== undefined && parent.name === identifier) || parent.parent.parent.moduleSpecifier !== undefined;
    }
    return (
      ((ts.isVariableDeclaration(parent) ||
        ts.isParameter(parent) ||
        ts.isFunctionDeclaration(parent) ||
        ts.isFunctionExpression(parent) ||
        ts.isClassDeclaration(parent) ||
        ts.isBindingElement(parent) ||
        ts.isImportSpecifier(parent) ||
        ts.isImportClause(parent) ||
        ts.isNamespaceImport(parent) ||
        ts.isImportEqualsDeclaration(parent) ||
        ts.isPropertyAssignment(parent) ||
        ts.isPropertyDeclaration(parent) ||
        ts.isPropertySignature(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isMethodSignature(parent) ||
        ts.isInterfaceDeclaration(parent) ||
        ts.isTypeAliasDeclaration(parent) ||
        ts.isEnumMember(parent)) &&
        parent.name === identifier) ||
      (ts.isBindingElement(parent) && parent.propertyName === identifier) ||
      (ts.isPropertyAccessExpression(parent) && parent.name === identifier) ||
      (ts.isImportSpecifier(parent) && parent.propertyName === identifier) ||
      ts.isQualifiedName(parent) ||
      ts.isTypeQueryNode(parent) ||
      ts.isTypeReferenceNode(parent) ||
      ts.isLabeledStatement(parent) ||
      ts.isBreakOrContinueStatement(parent)
    );
  };

  /** Checks how a known loader-related object is used; anything but the allowed shapes is reported. */
  const checkKnownUse = (node: ts.Expression, kind: KnownObject): void => {
    const usage = outermost(node);
    const parent = usage.parent;
    const label = snippet(unwrap(node));

    if (ts.isTypeOfExpression(parent) || (ts.isExpressionStatement(parent) && ts.isVoidExpression(usage))) {
      return;
    }
    if (ts.isCallExpression(parent) && parent.expression === usage) {
      if (kind === "createRequire") {
        // A createRequire result must be bound to a local name or invoked immediately.
        const call = outermost(parent);
        const holder = call.parent;
        const bound = ts.isVariableDeclaration(holder) && holder.initializer === call && ts.isIdentifier(holder.name);
        const invoked = ts.isCallExpression(holder) && holder.expression === call;
        if (!bound && !invoked) {
          reportEscape(parent, `${label}(...)`);
        }
        return;
      }
      if (LOADING_KINDS.has(kind) || kind === "builtin") {
        return; // handled as a load in visit()
      }
      reportEscape(node, label); // calling process/module/global objects themselves
      return;
    }
    if (isMemberAccess(parent) && parent.expression === usage) {
      const name = memberName(parent);
      if (name === undefined) {
        reportEscape(parent, `${label}[computed]`);
        return;
      }
      if (known(parent) !== undefined) {
        return; // the member is itself a known object and is checked on its own visit
      }
      if (SENSITIVE_MEMBERS[kind].has(name)) {
        reportEscape(parent, `${label}.${name}`);
      }
      return;
    }
    if (ts.isVariableDeclaration(parent) && parent.initializer === usage && ts.isObjectBindingPattern(parent.name)) {
      const leaks = parent.name.elements.some((element) => {
        if (element.dotDotDotToken) return true;
        const property = element.propertyName ?? element.name;
        const name = ts.isIdentifier(property) || ts.isStringLiteralLike(property) ? property.text : undefined;
        return name === undefined || SENSITIVE_MEMBERS[kind].has(name);
      });
      if (leaks || LOADING_KINDS.has(kind) || kind === "builtin" || kind === "createRequire") {
        reportEscape(node, label);
      }
      return;
    }
    reportEscape(node, label);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && !isDeclarationName(node)) {
      const kind = known(node);
      if (kind !== undefined) checkKnownUse(node, kind);
    } else if (isMemberAccess(node)) {
      const kind = known(node);
      if (kind !== undefined) checkKnownUse(node, kind);
    }

    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      if (ts.isStringLiteralLike(node.moduleReference.expression)) imports.push(node.moduleReference.expression.text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
      imports.push(node.argument.literal.text);
    } else if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      const kind = callee.kind === ts.SyntaxKind.ImportKeyword ? "import" : known(callee);
      if (kind === "import" || (kind !== undefined && LOADING_KINDS.has(kind))) {
        addLoaderTarget(node);
      } else if (kind === "builtin") {
        const folded = node.arguments[0] ? foldConstantString(node.arguments[0]) : undefined;
        if (folded === undefined) {
          unresolvedModuleLoads.push(snippet(node));
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
