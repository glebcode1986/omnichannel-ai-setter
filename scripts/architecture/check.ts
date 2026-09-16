import { isBuiltin } from "node:module";
import path from "node:path";

import {
  GLOBALLY_FORBIDDEN_DEPENDENCIES,
  PACKAGE_RULES,
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

export interface SourceFile {
  /** Path relative to the package directory, POSIX separators (e.g. `src/index.ts`). */
  readonly path: string;
  /** Module specifiers imported/required/re-exported by the file. */
  readonly imports: readonly string[];
}

export interface WorkspacePackage {
  readonly name: string;
  /** Repository-relative package directory, POSIX separators (e.g. `packages/domain`). */
  readonly dir: string;
  readonly manifest: Readonly<Partial<Record<DependencyField, Readonly<Record<string, string>>>>>;
  readonly sourceFiles: readonly SourceFile[];
}

export type ViolationKind =
  | "unknown-package"
  | "missing-package"
  | "non-workspace-protocol"
  | "disallowed-workspace-dependency"
  | "dependency-cycle"
  | "forbidden-dependency"
  | "disallowed-workspace-import"
  | "undeclared-import"
  | "dev-dependency-in-runtime-code"
  | "forbidden-import"
  | "node-builtin-in-pure-package"
  | "cross-package-relative-import";

export interface Violation {
  readonly kind: ViolationKind;
  readonly packageName: string;
  /** Repository-relative file path when the violation comes from source code. */
  readonly file?: string;
  readonly message: string;
}

export interface CheckOptions {
  readonly rules?: Readonly<Record<string, PackageRule>>;
  /** Root `devDependencies`; test and tooling files may import these (e.g. `vitest`). */
  readonly rootDevDependencies?: readonly string[];
}

export function packageNameOf(specifier: string): string {
  const [first = "", second = ""] = specifier.split("/");
  return specifier.startsWith("@") ? `${first}/${second}` : first;
}

export function matchesPackagePattern(name: string, pattern: string): boolean {
  return pattern.endsWith("/*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
}

export function isWorkspacePackageName(name: string): boolean {
  return name.startsWith(WORKSPACE_SCOPE);
}

/** Runtime code ships to production: anything under `src/` that is not a test/fixture. */
export function isRuntimeSourceFile(filePath: string): boolean {
  if (!filePath.startsWith("src/")) {
    return false;
  }
  const segments = filePath.split("/");
  const fileName = segments.at(-1) ?? "";
  const inTestDirectory = segments.some((segment) =>
    ["__tests__", "__mocks__", "__fixtures__", "test", "tests", "fixtures"].includes(segment),
  );
  return !inTestDirectory && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(fileName);
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

function declaredFields(workspacePackage: WorkspacePackage, name: string): DependencyField[] {
  return DEPENDENCY_FIELDS.filter((field) => workspacePackage.manifest[field]?.[name] !== undefined);
}

export function checkWorkspace(packages: readonly WorkspacePackage[], options: CheckOptions = {}): Violation[] {
  const rules = options.rules ?? PACKAGE_RULES;
  const rootDevDependencies = new Set(options.rootDevDependencies ?? []);
  const violations: Violation[] = [];
  const packagesByName = new Map(packages.map((workspacePackage) => [workspacePackage.name, workspacePackage]));

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
    violations.push(...checkManifest(workspacePackage, rule, rules, packagesByName));
    violations.push(...checkSourceImports(workspacePackage, rule, rules, rootDevDependencies));
  }

  violations.push(...findDependencyCycles(packages));
  return violations;
}

function checkManifest(
  workspacePackage: WorkspacePackage,
  rule: PackageRule,
  rules: Readonly<Record<string, PackageRule>>,
  packagesByName: ReadonlyMap<string, WorkspacePackage>,
): Violation[] {
  const violations: Violation[] = [];
  const from = workspacePackage.name;

  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, version] of Object.entries(workspacePackage.manifest[field] ?? {})) {
      if (GLOBALLY_FORBIDDEN_DEPENDENCIES.some((pattern) => matchesPackagePattern(name, pattern))) {
        violations.push({
          kind: "forbidden-dependency",
          packageName: from,
          message: `${from} ${field} includes ${name}, an unofficial transport/automation library rejected by ADR-002.`,
        });
        continue;
      }

      if (!isWorkspacePackageName(name)) {
        if (rule.forbiddenThirdParty?.some((pattern) => matchesPackagePattern(name, pattern))) {
          violations.push({
            kind: "forbidden-dependency",
            packageName: from,
            message: `${from} (${rule.layer}) must not depend on ${name} (${field}); core packages cannot use concrete infrastructure.`,
          });
        }
        continue;
      }

      if (!version.startsWith("workspace:")) {
        violations.push({
          kind: "non-workspace-protocol",
          packageName: from,
          message: `${from} ${field}.${name} must use the workspace: protocol (found "${version}").`,
        });
      }
      if (name === from) {
        violations.push({
          kind: "disallowed-workspace-dependency",
          packageName: from,
          message: `${from} must not depend on itself (${field}).`,
        });
      } else if (!packagesByName.has(name) || !isAllowedWorkspaceEdge(rule, name, rules)) {
        violations.push({
          kind: "disallowed-workspace-dependency",
          packageName: from,
          message: `${from} (${rule.layer}) must not depend on ${name} (${field}). Allowed: ${describeAllowed(rule)}.`,
        });
      }
    }
  }
  return violations;
}

function checkSourceImports(
  workspacePackage: WorkspacePackage,
  rule: PackageRule,
  rules: Readonly<Record<string, PackageRule>>,
  rootDevDependencies: ReadonlySet<string>,
): Violation[] {
  const violations: Violation[] = [];
  const from = workspacePackage.name;

  for (const sourceFile of workspacePackage.sourceFiles) {
    const file = path.posix.join(workspacePackage.dir, sourceFile.path);
    const runtime = isRuntimeSourceFile(sourceFile.path);
    const report = (kind: ViolationKind, message: string) =>
      violations.push({ kind, packageName: from, file, message });

    for (const specifier of new Set(sourceFile.imports)) {
      if (specifier.startsWith(".") || specifier.startsWith("/")) {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(sourceFile.path), specifier));
        if (specifier.startsWith("/") || resolved === ".." || resolved.startsWith("../")) {
          report(
            "cross-package-relative-import",
            `"${specifier}" escapes ${workspacePackage.dir}; import other packages by name through their public entrypoint.`,
          );
        }
        continue;
      }

      // Subpath imports (`#internal`) are package-private by definition.
      if (specifier.startsWith("#")) {
        continue;
      }

      if (specifier.startsWith("node:") || isBuiltin(specifier)) {
        if (rule.pure && runtime) {
          report(
            "node-builtin-in-pure-package",
            `"${specifier}" is a Node.js built-in; ${from} is pure and must not use runtime I/O or process APIs.`,
          );
        }
        continue;
      }

      const name = packageNameOf(specifier);

      if (isWorkspacePackageName(name)) {
        if (name === from) {
          continue;
        }
        if (!isAllowedWorkspaceEdge(rule, name, rules)) {
          report(
            "disallowed-workspace-import",
            `"${specifier}" is not allowed from ${from} (${rule.layer}). Allowed: ${describeAllowed(rule)}.`,
          );
        } else if (declaredFields(workspacePackage, name).length === 0) {
          report("undeclared-import", `"${specifier}" is imported but ${name} is not declared in package.json.`);
        }
        continue;
      }

      if (
        GLOBALLY_FORBIDDEN_DEPENDENCIES.some((pattern) => matchesPackagePattern(name, pattern)) ||
        rule.forbiddenThirdParty?.some((pattern) => matchesPackagePattern(name, pattern))
      ) {
        report("forbidden-import", `"${specifier}" is forbidden in ${from} (${rule.layer}).`);
        continue;
      }

      const fields = declaredFields(workspacePackage, name);
      if (runtime) {
        if (fields.length === 0) {
          report("undeclared-import", `"${specifier}" is imported by runtime code but ${name} is not declared.`);
        } else if (fields.every((field) => field === "devDependencies")) {
          report(
            "dev-dependency-in-runtime-code",
            `"${specifier}" is imported by runtime code but ${name} is only a devDependency.`,
          );
        }
      } else if (fields.length === 0 && !rootDevDependencies.has(name)) {
        report(
          "undeclared-import",
          `"${specifier}" is imported but ${name} is declared neither by ${from} nor by the workspace root.`,
        );
      }
    }
  }
  return violations;
}

/** Detects cycles across all dependency fields between workspace packages. */
export function findDependencyCycles(packages: readonly WorkspacePackage[]): Violation[] {
  const names = new Set(packages.map((workspacePackage) => workspacePackage.name));
  const edges = new Map<string, string[]>();
  for (const workspacePackage of packages) {
    const targets = new Set<string>();
    for (const field of DEPENDENCY_FIELDS) {
      for (const name of Object.keys(workspacePackage.manifest[field] ?? {})) {
        if (names.has(name)) {
          targets.add(name);
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
