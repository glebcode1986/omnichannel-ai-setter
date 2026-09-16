import { isBuiltin } from "node:module";
import path from "node:path";

import {
  GLOBALLY_FORBIDDEN_DEPENDENCIES,
  PACKAGE_RULES,
  RUNTIME_FORBIDDEN_DEPENDENCIES,
  WORKSPACE_SCOPE,
  type PackageRule,
} from "./rules.ts";

export const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

export type DependencyField = (typeof DEPENDENCY_FIELDS)[number];

export type Manifest = Readonly<Partial<Record<DependencyField, Readonly<Record<string, string>>>>>;

export interface SourceFile {
  /** Path relative to the package (or repository root) directory, POSIX separators (e.g. `src/index.ts`). */
  readonly path: string;
  /** Module specifiers imported/required/re-exported, plus `/// <reference path>` targets. */
  readonly imports: readonly string[];
  /** `/// <reference types="..." />` directives. */
  readonly typeReferences?: readonly string[];
}

/** A module alias from package.json `imports` or tsconfig `paths`. */
export interface ModuleAlias {
  /** e.g. `#internal/*` or `@/*` — at most one `*`. */
  readonly pattern: string;
  /** Package-relative paths (`./src/*`) or bare specifiers (`zod`). */
  readonly targets: readonly string[];
}

export interface WorkspacePackage {
  readonly name: string;
  /** Repository-relative package directory, POSIX separators (e.g. `packages/domain`). */
  readonly dir: string;
  readonly manifest: Manifest;
  readonly sourceFiles: readonly SourceFile[];
  /** Effective `compilerOptions.types` of the package tsconfig (undefined = not configured). */
  readonly tsconfigTypes?: readonly string[];
  readonly aliases?: readonly ModuleAlias[];
  /** Package-relative paths of symbolic links found inside the package tree. */
  readonly symlinks?: readonly string[];
}

export interface RootWorkspace {
  readonly manifest: Manifest;
  /** Root tooling sources (e.g. `scripts/**`), paths relative to the repository root. */
  readonly sourceFiles: readonly SourceFile[];
}

export type ViolationKind =
  | "unknown-package"
  | "missing-package"
  | "non-workspace-protocol"
  | "aliased-dependency"
  | "disallowed-workspace-dependency"
  | "dependency-cycle"
  | "forbidden-dependency"
  | "inconsistent-dependency-version"
  | "disallowed-workspace-import"
  | "undeclared-import"
  | "dev-dependency-in-runtime-code"
  | "forbidden-import"
  | "node-builtin-in-pure-package"
  | "node-types-in-pure-package"
  | "cross-package-relative-import"
  | "unresolved-alias-import"
  | "invalid-import-specifier"
  | "symlink-in-package";

export interface Violation {
  readonly kind: ViolationKind;
  readonly packageName: string;
  /** Repository-relative file path when the violation comes from source code. */
  readonly file?: string;
  readonly message: string;
}

export interface CheckOptions {
  readonly rules?: Readonly<Record<string, PackageRule>>;
  /** Root manifest and tooling sources; root devDependencies may be imported by test/tooling files. */
  readonly root?: RootWorkspace;
}

const ROOT_PACKAGE = "(workspace root)";

export function packageNameOf(specifier: string): string {
  const [first = "", second = ""] = specifier.split("/");
  return specifier.startsWith("@") ? `${first}/${second}` : first;
}

/** npm package names: optional `@scope/`, lowercase URL-safe characters. */
export function isValidPackageName(name: string): boolean {
  return /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(name);
}

export function matchesPackagePattern(name: string, pattern: string): boolean {
  return pattern.endsWith("/*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
}

const matchesAny = (name: string, patterns: readonly string[] | undefined): boolean =>
  patterns?.some((pattern) => matchesPackagePattern(name, pattern)) ?? false;

export function isWorkspacePackageName(name: string): boolean {
  return name.startsWith(WORKSPACE_SCOPE);
}

const TEST_FILE_NAME = /\.(?:test|spec|test-d|spec-d|bench)\.[cm]?[jt]sx?$/;
const TEST_SUPPORT_FILE_NAME = /^(?:vitest\.setup|test-utils|test-helpers)\.[cm]?[jt]sx?$/;
const TEST_DIRECTORIES_ANY_DEPTH = new Set(["__tests__", "__mocks__", "__fixtures__"]);
const TEST_DIRECTORIES_DIRECTLY_UNDER_SRC = new Set(["test", "tests", "testing", "fixtures"]);

/**
 * Runtime code ships to production: anything under `src/` except tests and test support.
 * `__tests__`-style directories are exempt at any depth; plain `test(s)/testing/fixtures`
 * directories only directly under `src/`, so production code cannot hide in a nested `fixtures/`.
 */
export function isRuntimeSourceFile(filePath: string): boolean {
  const segments = filePath.split("/");
  if (segments[0] !== "src" || segments.length < 2) {
    return false;
  }
  const directories = segments.slice(1, -1);
  const fileName = segments.at(-1) ?? "";
  if (directories.some((directory) => TEST_DIRECTORIES_ANY_DEPTH.has(directory))) {
    return false;
  }
  if (directories.length > 0 && TEST_DIRECTORIES_DIRECTLY_UNDER_SRC.has(directories[0] ?? "")) {
    return false;
  }
  return !TEST_FILE_NAME.test(fileName) && !TEST_SUPPORT_FILE_NAME.test(fileName);
}

function isAllowedWorkspaceEdge(
  rule: PackageRule,
  target: string,
  rules: Readonly<Record<string, PackageRule>>,
): boolean {
  if (rule.allowedWorkspaceDependencies === "all-packages") {
    const targetRule = rules[target];
    return targetRule !== undefined && targetRule.layer !== "app";
  }
  return rule.allowedWorkspaceDependencies.includes(target);
}

function describeAllowed(rule: PackageRule): string {
  if (rule.allowedWorkspaceDependencies === "all-packages") {
    return "any non-app workspace package";
  }
  return rule.allowedWorkspaceDependencies.length > 0
    ? rule.allowedWorkspaceDependencies.join(", ")
    : "no workspace packages";
}

function declaredFields(manifest: Manifest, name: string): DependencyField[] {
  return DEPENDENCY_FIELDS.filter((field) => manifest[field]?.[name] !== undefined);
}

interface ResolvedDependency {
  readonly field: DependencyField;
  readonly key: string;
  readonly spec: string;
  /** Package the entry really installs: the key, an alias target, or the package at a local path. */
  readonly target: string;
  /** Set when the entry installs something under a different name or from a local path. */
  readonly indirection?: string;
}

const WORKSPACE_RANGE = /^(?:\*|\^|~|[\^~]?\d[\w.+-]*)$/;

function parseAliasTarget(value: string): string {
  // `@scope/name@range` or `name@range`
  const at = value.indexOf("@", value.startsWith("@") ? 1 : 0);
  return at === -1 ? value : value.slice(0, at);
}

function resolveDependency(
  owner: { dir: string },
  field: DependencyField,
  key: string,
  spec: string,
  packagesByDir: ReadonlyMap<string, WorkspacePackage>,
): ResolvedDependency {
  const base = { field, key, spec };
  const resolveLocalPath = (localPath: string): string => {
    const resolved = path.posix.normalize(path.posix.join(owner.dir, localPath.replaceAll("\\", "/")));
    return packagesByDir.get(resolved)?.name ?? `(path ${resolved})`;
  };

  if (spec.startsWith("workspace:")) {
    const rest = spec.slice("workspace:".length);
    if (WORKSPACE_RANGE.test(rest)) {
      return { ...base, target: key };
    }
    if (rest.startsWith(".") || rest.startsWith("/")) {
      return { ...base, target: resolveLocalPath(rest), indirection: "path-based workspace: protocol" };
    }
    return { ...base, target: parseAliasTarget(rest), indirection: "workspace: alias" };
  }
  for (const protocol of ["link:", "file:", "portal:"]) {
    if (spec.startsWith(protocol)) {
      return { ...base, target: resolveLocalPath(spec.slice(protocol.length)), indirection: `${protocol} protocol` };
    }
  }
  if (spec.startsWith("npm:")) {
    return { ...base, target: parseAliasTarget(spec.slice("npm:".length)), indirection: "npm: alias" };
  }
  return { ...base, target: key };
}

export function checkWorkspace(packages: readonly WorkspacePackage[], options: CheckOptions = {}): Violation[] {
  const rules = options.rules ?? PACKAGE_RULES;
  const root = options.root;
  const violations: Violation[] = [];
  const packagesByName = new Map(packages.map((workspacePackage) => [workspacePackage.name, workspacePackage]));
  const packagesByDir = new Map(packages.map((workspacePackage) => [workspacePackage.dir, workspacePackage]));

  for (const expectedName of Object.keys(rules)) {
    if (!packagesByName.has(expectedName)) {
      violations.push({
        kind: "missing-package",
        packageName: expectedName,
        message: `Package ${expectedName} is required by the repository layout but was not found in the workspace.`,
      });
    }
  }

  for (const workspacePackage of packages) {
    const rule = rules[workspacePackage.name];
    if (!rule) {
      violations.push({
        kind: "unknown-package",
        packageName: workspacePackage.name,
        message:
          `Package ${workspacePackage.name} (${workspacePackage.dir}) has no boundary rule. ` +
          "Add it to scripts/architecture/rules.ts and docs/specs/REPOSITORY_LAYOUT.md.",
      });
      continue;
    }
    violations.push(...checkManifest(workspacePackage, rule, rules, packagesByName, packagesByDir));
    violations.push(...checkPackageConfiguration(workspacePackage, rule));
    violations.push(...checkSourceImports(workspacePackage, rule, rules, root?.manifest));
  }

  if (root) {
    violations.push(...checkRoot(root));
  }
  violations.push(...findInconsistentVersions(packages, root));
  violations.push(...findDependencyCycles(packages));
  return violations;
}

function checkManifest(
  workspacePackage: WorkspacePackage,
  rule: PackageRule,
  rules: Readonly<Record<string, PackageRule>>,
  packagesByName: ReadonlyMap<string, WorkspacePackage>,
  packagesByDir: ReadonlyMap<string, WorkspacePackage>,
): Violation[] {
  const violations: Violation[] = [];
  const from = workspacePackage.name;
  const report = (kind: ViolationKind, message: string) => violations.push({ kind, packageName: from, message });

  for (const field of DEPENDENCY_FIELDS) {
    for (const [key, spec] of Object.entries(workspacePackage.manifest[field] ?? {})) {
      const dependency = resolveDependency(workspacePackage, field, key, spec, packagesByDir);
      const { target } = dependency;
      const shown = target === key ? key : `${key} (-> ${target})`;

      if (dependency.indirection) {
        report(
          "aliased-dependency",
          `${from} ${field}.${key} uses a ${dependency.indirection} ("${spec}"). Aliases and local-path protocols ` +
            "hide architecture edges; depend on registry packages or @omnichannel/* packages via workspace:* by name.",
        );
      }

      if (matchesAny(target, GLOBALLY_FORBIDDEN_DEPENDENCIES) || matchesAny(key, GLOBALLY_FORBIDDEN_DEPENDENCIES)) {
        report(
          "forbidden-dependency",
          `${from} ${field} includes ${shown}, an unofficial transport/automation library rejected by ADR-002.`,
        );
        continue;
      }
      if (field !== "devDependencies" && (matchesAny(target, RUNTIME_FORBIDDEN_DEPENDENCIES) || matchesAny(key, RUNTIME_FORBIDDEN_DEPENDENCIES))) {
        report(
          "forbidden-dependency",
          `${from} ${field} includes ${shown}; browser automation may only be a devDependency for tests (ADR-002).`,
        );
      }

      if (!isWorkspacePackageName(target) && !isWorkspacePackageName(key)) {
        if (matchesAny(target, rule.forbiddenThirdParty) || matchesAny(key, rule.forbiddenThirdParty)) {
          report(
            "forbidden-dependency",
            `${from} (${rule.layer}) must not depend on ${shown} (${field}); core packages cannot use concrete infrastructure.`,
          );
        }
        continue;
      }

      if (isWorkspacePackageName(key) && !spec.startsWith("workspace:")) {
        report("non-workspace-protocol", `${from} ${field}.${key} must use the workspace: protocol (found "${spec}").`);
      }
      if (target === from) {
        report("disallowed-workspace-dependency", `${from} must not depend on itself (${field}).`);
      } else if (!packagesByName.has(target) || !isAllowedWorkspaceEdge(rule, target, rules)) {
        report(
          "disallowed-workspace-dependency",
          `${from} (${rule.layer}) must not depend on ${shown} (${field}). Allowed: ${describeAllowed(rule)}.`,
        );
      }
    }
  }
  return violations;
}

function checkPackageConfiguration(workspacePackage: WorkspacePackage, rule: PackageRule): Violation[] {
  const violations: Violation[] = [];
  const from = workspacePackage.name;

  for (const symlink of workspacePackage.symlinks ?? []) {
    violations.push({
      kind: "symlink-in-package",
      packageName: from,
      file: path.posix.join(workspacePackage.dir, symlink),
      message: "Symbolic links inside a package can silently pull in another package's sources; remove the link.",
    });
  }

  if (rule.pure && workspacePackage.tsconfigTypes?.some((type) => type === "node" || type === "@types/node")) {
    violations.push({
      kind: "node-types-in-pure-package",
      packageName: from,
      file: path.posix.join(workspacePackage.dir, "tsconfig.json"),
      message: `${from} is pure; its tsconfig must not load Node.js types (compilerOptions.types includes "node").`,
    });
  }
  return violations;
}

function matchAlias(specifier: string, aliases: readonly ModuleAlias[]): string[] | undefined {
  for (const alias of aliases) {
    const star = alias.pattern.indexOf("*");
    if (star === -1) {
      if (alias.pattern === specifier) {
        return [...alias.targets];
      }
      continue;
    }
    const prefix = alias.pattern.slice(0, star);
    const suffix = alias.pattern.slice(star + 1);
    if (specifier.length >= prefix.length + suffix.length && specifier.startsWith(prefix) && specifier.endsWith(suffix)) {
      const captured = specifier.slice(prefix.length, specifier.length - suffix.length);
      return alias.targets.map((target) => target.replace("*", captured));
    }
  }
  return undefined;
}

function checkSourceImports(
  workspacePackage: WorkspacePackage,
  rule: PackageRule,
  rules: Readonly<Record<string, PackageRule>>,
  rootManifest: Manifest | undefined,
): Violation[] {
  const violations: Violation[] = [];
  const from = workspacePackage.name;
  const rootDevDependencies = rootManifest?.devDependencies ?? {};

  for (const sourceFile of workspacePackage.sourceFiles) {
    const file = path.posix.join(workspacePackage.dir, sourceFile.path);
    const runtime = isRuntimeSourceFile(sourceFile.path);
    const report = (kind: ViolationKind, message: string) =>
      violations.push({ kind, packageName: from, file, message });

    const checkLocalPath = (specifier: string, packageRelativeTarget: string) => {
      const resolved = path.posix.normalize(packageRelativeTarget);
      if (packageRelativeTarget.startsWith("/") || resolved === ".." || resolved.startsWith("../")) {
        report(
          "cross-package-relative-import",
          `"${specifier}" escapes ${workspacePackage.dir}; import other packages by name through their public entrypoint.`,
        );
      }
    };

    const checkSpecifier = (specifier: string, depth: number): void => {
      if (specifier.includes("\\")) {
        report("invalid-import-specifier", `"${specifier}" contains backslashes; module specifiers must use "/".`);
        return;
      }

      const aliasTargets = depth === 0 ? matchAlias(specifier, workspacePackage.aliases ?? []) : undefined;
      if (aliasTargets) {
        for (const target of aliasTargets) {
          if (target.startsWith(".") || target.startsWith("/")) {
            checkLocalPath(specifier, target);
          } else {
            checkSpecifier(target, depth + 1);
          }
        }
        return;
      }

      if (specifier.startsWith("#")) {
        report(
          "unresolved-alias-import",
          `"${specifier}" matches no package.json "imports" entry or tsconfig "paths" alias of ${from}.`,
        );
        return;
      }

      if (specifier.startsWith("/")) {
        checkLocalPath(specifier, specifier);
        return;
      }
      if (specifier.startsWith(".")) {
        checkLocalPath(specifier, path.posix.join(path.posix.dirname(sourceFile.path), specifier));
        return;
      }

      if (specifier.startsWith("node:") || isBuiltin(specifier)) {
        if (rule.pure && runtime) {
          report(
            "node-builtin-in-pure-package",
            `"${specifier}" is a Node.js built-in; ${from} is pure and must not use runtime I/O or process APIs.`,
          );
        }
        return;
      }

      const name = packageNameOf(specifier);
      if (!isValidPackageName(name)) {
        report(
          "invalid-import-specifier",
          `"${specifier}" is neither a relative path, a package name nor a declared alias of ${from}.`,
        );
        return;
      }
      const fields = declaredFields(workspacePackage.manifest, name);

      if (isWorkspacePackageName(name)) {
        if (name === from) {
          return;
        }
        if (!isAllowedWorkspaceEdge(rule, name, rules)) {
          report(
            "disallowed-workspace-import",
            `"${specifier}" is not allowed from ${from} (${rule.layer}). Allowed: ${describeAllowed(rule)}.`,
          );
        } else if (fields.length === 0) {
          report("undeclared-import", `"${specifier}" is imported but ${name} is not declared in package.json.`);
        } else if (runtime && fields.every((field) => field === "devDependencies")) {
          report(
            "dev-dependency-in-runtime-code",
            `"${specifier}" is imported by runtime code but ${name} is only a devDependency.`,
          );
        }
        return;
      }

      if (matchesAny(name, GLOBALLY_FORBIDDEN_DEPENDENCIES) || matchesAny(name, rule.forbiddenThirdParty)) {
        report("forbidden-import", `"${specifier}" is forbidden in ${from} (${rule.layer}).`);
        return;
      }
      if (runtime && matchesAny(name, RUNTIME_FORBIDDEN_DEPENDENCIES)) {
        report("forbidden-import", `"${specifier}" (browser automation) must not be imported by runtime code (ADR-002).`);
        return;
      }

      if (runtime) {
        if (fields.length === 0) {
          report("undeclared-import", `"${specifier}" is imported by runtime code but ${name} is not declared.`);
        } else if (fields.every((field) => field === "devDependencies")) {
          report(
            "dev-dependency-in-runtime-code",
            `"${specifier}" is imported by runtime code but ${name} is only a devDependency.`,
          );
        }
      } else if (fields.length === 0 && rootDevDependencies[name] === undefined) {
        report(
          "undeclared-import",
          `"${specifier}" is imported but ${name} is declared neither by ${from} nor by the workspace root.`,
        );
      }
    };

    for (const specifier of new Set(sourceFile.imports)) {
      checkSpecifier(specifier, 0);
    }

    for (const typeReference of new Set(sourceFile.typeReferences ?? [])) {
      if (typeReference === "node") {
        if (rule.pure && runtime) {
          report(
            "node-types-in-pure-package",
            `/// <reference types="node" /> loads Node.js globals into ${from}, which is pure.`,
          );
        }
        continue;
      }
      checkSpecifier(typeReference, 0);
    }
  }
  return violations;
}

function checkRoot(root: RootWorkspace): Violation[] {
  const violations: Violation[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    for (const [key, spec] of Object.entries(root.manifest[field] ?? {})) {
      const target = spec.startsWith("npm:") ? parseAliasTarget(spec.slice("npm:".length)) : key;
      if (matchesAny(key, GLOBALLY_FORBIDDEN_DEPENDENCIES) || matchesAny(target, GLOBALLY_FORBIDDEN_DEPENDENCIES)) {
        violations.push({
          kind: "forbidden-dependency",
          packageName: ROOT_PACKAGE,
          message: `Root package.json ${field} includes ${key}, an unofficial transport/automation library rejected by ADR-002.`,
        });
      } else if (field !== "devDependencies" && matchesAny(target, RUNTIME_FORBIDDEN_DEPENDENCIES)) {
        violations.push({
          kind: "forbidden-dependency",
          packageName: ROOT_PACKAGE,
          message: `Root package.json ${field} includes ${key}; browser automation may only be a devDependency (ADR-002).`,
        });
      }
    }
  }
  for (const sourceFile of root.sourceFiles) {
    for (const specifier of new Set(sourceFile.imports)) {
      if (matchesAny(packageNameOf(specifier), GLOBALLY_FORBIDDEN_DEPENDENCIES)) {
        violations.push({
          kind: "forbidden-import",
          packageName: ROOT_PACKAGE,
          file: sourceFile.path,
          message: `"${specifier}" is an unofficial transport/automation library rejected by ADR-002.`,
        });
      }
    }
  }
  return violations;
}

/**
 * A third-party package must be declared with the same range everywhere (root included). Otherwise
 * a workspace package can run against one version in dev/tests and another in an app bundle.
 * `peerDependencies` are exempt because they intentionally express compatibility ranges.
 */
export function findInconsistentVersions(packages: readonly WorkspacePackage[], root?: RootWorkspace): Violation[] {
  const declarations = new Map<string, { owner: string; field: DependencyField; spec: string }[]>();
  const owners: { name: string; manifest: Manifest }[] = [
    ...(root ? [{ name: ROOT_PACKAGE, manifest: root.manifest }] : []),
    ...packages.map((workspacePackage) => ({ name: workspacePackage.name, manifest: workspacePackage.manifest })),
  ];
  for (const owner of owners) {
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
      for (const [key, spec] of Object.entries(owner.manifest[field] ?? {})) {
        if (isWorkspacePackageName(key) || spec.startsWith("workspace:")) {
          continue;
        }
        const list = declarations.get(key) ?? [];
        list.push({ owner: owner.name, field, spec });
        declarations.set(key, list);
      }
    }
  }

  const violations: Violation[] = [];
  for (const [name, list] of [...declarations].sort(([a], [b]) => a.localeCompare(b))) {
    if (new Set(list.map((declaration) => declaration.spec)).size > 1) {
      violations.push({
        kind: "inconsistent-dependency-version",
        packageName: list[0]?.owner ?? ROOT_PACKAGE,
        message:
          `${name} is declared with different ranges: ` +
          list.map((declaration) => `${declaration.owner} ${declaration.field} "${declaration.spec}"`).join(", ") +
          ". Use one range across the workspace.",
      });
    }
  }
  return violations;
}

/** Detects cycles across all dependency fields between workspace packages (aliases resolved). */
export function findDependencyCycles(packages: readonly WorkspacePackage[]): Violation[] {
  const names = new Set(packages.map((workspacePackage) => workspacePackage.name));
  const packagesByDir = new Map(packages.map((workspacePackage) => [workspacePackage.dir, workspacePackage]));
  const edges = new Map<string, string[]>();
  for (const workspacePackage of packages) {
    const targets = new Set<string>();
    for (const field of DEPENDENCY_FIELDS) {
      for (const [key, spec] of Object.entries(workspacePackage.manifest[field] ?? {})) {
        const { target } = resolveDependency(workspacePackage, field, key, spec, packagesByDir);
        if (names.has(target)) {
          targets.add(target);
        }
      }
    }
    edges.set(workspacePackage.name, [...targets].sort());
  }

  const violations: Violation[] = [];
  const reported = new Set<string>();
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (node: string): void => {
    state.set(node, "visiting");
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      const nextState = state.get(next);
      if (nextState === "visiting") {
        const cycle = stack.slice(stack.indexOf(next));
        const key = canonicalCycleKey(cycle);
        if (!reported.has(key)) {
          reported.add(key);
          violations.push({
            kind: "dependency-cycle",
            packageName: next,
            message: `Circular workspace dependency: ${[...cycle, next].join(" -> ")}.`,
          });
        }
      } else if (nextState === undefined) {
        visit(next);
      }
    }
    stack.pop();
    state.set(node, "done");
  };

  for (const name of [...names].sort()) {
    if (!state.has(name)) {
      visit(name);
    }
  }
  return violations;
}

function canonicalCycleKey(cycle: readonly string[]): string {
  const smallest = cycle.reduce((min, name, index) => (name < (cycle[min] ?? "") ? index : min), 0);
  return [...cycle.slice(smallest), ...cycle.slice(0, smallest)].join(">");
}
