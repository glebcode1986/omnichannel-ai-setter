/**
 * `pnpm lint:boundaries` — fails when workspace packages violate the dependency direction in
 * ADR-008 / REPOSITORY_LAYOUT.md, form cycles, or import undeclared/forbidden modules.
 */
import path from "node:path";

import { checkWorkspace } from "./check.ts";
import { loadWorkspace } from "./workspace.ts";

const rootDir = path.resolve(import.meta.dirname, "../..");
const { packages, root } = await loadWorkspace(rootDir);
const violations = checkWorkspace(packages, { root });

if (violations.length > 0) {
  console.error(`Architecture boundary check failed with ${violations.length} violation(s):\n`);
  for (const violation of violations) {
    const location = violation.file ?? violation.packageName;
    console.error(`  [${violation.kind}] ${location}\n    ${violation.message}`);
  }
  process.exit(1);
}

const fileCount = packages.reduce((total, workspacePackage) => total + workspacePackage.sourceFiles.length, 0);
console.log(
  `Architecture boundaries OK: ${packages.length} packages, ${fileCount} package source files, ` +
    `${root.sourceFiles.length} root tooling files, no dependency cycles.`,
);
