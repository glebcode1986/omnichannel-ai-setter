import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  checkWorkspace,
  findDependencyCycles,
  isRuntimeSourceFile,
  packageNameOf,
  type DependencyField,
  type SourceFile,
  type Violation,
  type WorkspacePackage,
} from "./check.ts";
import { PACKAGE_RULES, WORKSPACE_SCOPE, type PackageRule } from "./rules.ts";
import { extractImports, loadWorkspace } from "./workspace.ts";

type Manifest = Partial<Record<DependencyField, Record<string, string>>>;

const scoped = (name: string) => `${WORKSPACE_SCOPE}${name}`;

function workspacePackage(name: string, manifest: Manifest = {}, sourceFiles: SourceFile[] = []): WorkspacePackage {
  const shortName = name.replace(WORKSPACE_SCOPE, "");
  const dir = shortName === "web" || shortName === "worker" ? `apps/${shortName}` : `packages/${shortName}`;
  return { name, dir, manifest, sourceFiles };
}

/** A valid workspace containing every package required by the rules, with no edges. */
function baselineWorkspace(overrides: WorkspacePackage[] = []): WorkspacePackage[] {
  const byName = new Map(Object.keys(PACKAGE_RULES).map((name) => [name, workspacePackage(name)]));
  for (const override of overrides) {
    byName.set(override.name, override);
  }
  return [...byName.values()];
}

const kinds = (violations: Violation[]) => violations.map((violation) => violation.kind);

describe("checkWorkspace: manifest rules", () => {
  it("accepts the canonical layout with ADR-008-compliant edges", () => {
    const violations = checkWorkspace(
      baselineWorkspace([
        workspacePackage(scoped("channel-core"), { dependencies: { [scoped("domain")]: "workspace:*" } }),
        workspacePackage(scoped("application"), {
          dependencies: { [scoped("domain")]: "workspace:*", [scoped("channel-core")]: "workspace:*" },
        }),
        workspacePackage(scoped("db"), {
          dependencies: { [scoped("application")]: "workspace:*", "@prisma/client": "^7.0.0" },
        }),
        workspacePackage(scoped("channel-whatsapp"), { dependencies: { [scoped("channel-core")]: "workspace:^" } }),
        workspacePackage(scoped("worker"), {
          dependencies: { [scoped("queue")]: "workspace:*", [scoped("channel-instagram")]: "workspace:*" },
        }),
      ]),
    );

    expect(violations).toEqual([]);
  });

  it.each([
    ["domain", "db"],
    ["domain", "channel-core"],
    ["channel-core", "application"],
    ["application", "db"],
    ["application", "queue"],
    ["application", "observability"],
    ["channel-instagram", "channel-whatsapp"],
    ["channel-whatsapp", "channel-instagram"],
    ["channel-instagram", "application"],
    ["ai", "channel-instagram"],
    ["db", "queue"],
    ["observability", "domain"],
    ["db", "web"],
    ["web", "worker"],
  ])("rejects %s -> %s", (from, to) => {
    const violations = checkWorkspace(
      baselineWorkspace([workspacePackage(scoped(from), { dependencies: { [scoped(to)]: "workspace:*" } })]),
    );

    expect(kinds(violations)).toEqual(["disallowed-workspace-dependency"]);
  });

  it("checks devDependencies and peerDependencies as architecture edges too", () => {
    const violations = checkWorkspace(
      baselineWorkspace([
        workspacePackage(scoped("domain"), {
          devDependencies: { [scoped("db")]: "workspace:*" },
          peerDependencies: { [scoped("queue")]: "workspace:*" },
        }),
      ]),
    );

    expect(kinds(violations)).toEqual(["disallowed-workspace-dependency", "disallowed-workspace-dependency"]);
  });

  it("requires the workspace: protocol for internal packages", () => {
    const violations = checkWorkspace(
      baselineWorkspace([workspacePackage(scoped("channel-core"), { dependencies: { [scoped("domain")]: "^0.0.0" } })]),
    );

    expect(kinds(violations)).toEqual(["non-workspace-protocol"]);
  });

  it("rejects self-dependencies", () => {
    const violations = checkWorkspace(
      baselineWorkspace([workspacePackage(scoped("domain"), { dependencies: { [scoped("domain")]: "workspace:*" } })]),
    );

    expect(kinds(violations)).toContain("disallowed-workspace-dependency");
  });

  it("reports packages without a rule and required packages that are missing", () => {
    const packages = baselineWorkspace().filter((candidate) => candidate.name !== scoped("queue"));
    packages.push(workspacePackage(scoped("billing")));

    expect(kinds(checkWorkspace(packages)).sort()).toEqual(["missing-package", "unknown-package"]);
  });

  it("forbids infrastructure libraries in core packages but not in infrastructure packages", () => {
    const violations = checkWorkspace(
      baselineWorkspace([
        workspacePackage(scoped("domain"), { dependencies: { "@prisma/client": "^7.0.0" } }),
        workspacePackage(scoped("application"), { dependencies: { bullmq: "^5.0.0" } }),
        workspacePackage(scoped("channel-core"), { devDependencies: { react: "^19.0.0" } }),
        workspacePackage(scoped("queue"), { dependencies: { bullmq: "^5.0.0", ioredis: "^5.0.0" } }),
      ]),
    );

    expect(violations.map((violation) => [violation.kind, violation.packageName])).toEqual([
      ["forbidden-dependency", scoped("domain")],
      ["forbidden-dependency", scoped("channel-core")],
      ["forbidden-dependency", scoped("application")],
    ]);
  });

  it("forbids unofficial WhatsApp/Instagram transports in every package and dependency field", () => {
    const violations = checkWorkspace(
      baselineWorkspace([
        workspacePackage(scoped("channel-whatsapp"), { dependencies: { "@whiskeysockets/baileys": "^6.0.0" } }),
        workspacePackage(scoped("worker"), { devDependencies: { "whatsapp-web.js": "^1.0.0" } }),
        workspacePackage(scoped("channel-instagram"), { optionalDependencies: { "instagram-private-api": "^1.0.0" } }),
      ]),
    );

    expect(kinds(violations)).toEqual(["forbidden-dependency", "forbidden-dependency", "forbidden-dependency"]);
  });
});

describe("findDependencyCycles", () => {
  const permissiveRules: Record<string, PackageRule> = {
    "@x/a": { layer: "support", allowedWorkspaceDependencies: ["@x/b"] },
    "@x/b": { layer: "support", allowedWorkspaceDependencies: ["@x/c"] },
    "@x/c": { layer: "support", allowedWorkspaceDependencies: ["@x/a"] },
  };

  it("reports each cycle once with its path", () => {
    const packages: WorkspacePackage[] = [
      { name: "@x/a", dir: "packages/a", manifest: { dependencies: { "@x/b": "workspace:*" } }, sourceFiles: [] },
      { name: "@x/b", dir: "packages/b", manifest: { devDependencies: { "@x/c": "workspace:*" } }, sourceFiles: [] },
      { name: "@x/c", dir: "packages/c", manifest: { peerDependencies: { "@x/a": "workspace:*" } }, sourceFiles: [] },
    ];

    const cycles = findDependencyCycles(packages);

    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.message).toBe("Circular workspace dependency: @x/a -> @x/b -> @x/c -> @x/a.");
    // Even when every edge is individually allowed, the cycle still fails the full check.
    expect(kinds(checkWorkspace(packages, { rules: permissiveRules }))).toContain("dependency-cycle");
  });

  it("does not report diamonds as cycles", () => {
    const packages: WorkspacePackage[] = [
      workspacePackage(scoped("worker"), {
        dependencies: { [scoped("application")]: "workspace:*", [scoped("db")]: "workspace:*" },
      }),
      workspacePackage(scoped("application"), { dependencies: { [scoped("domain")]: "workspace:*" } }),
      workspacePackage(scoped("db"), { dependencies: { [scoped("domain")]: "workspace:*" } }),
      workspacePackage(scoped("domain")),
    ];

    expect(findDependencyCycles(packages)).toEqual([]);
  });
});

describe("checkWorkspace: source imports", () => {
  const file = (filePath: string, imports: string[]): SourceFile => ({ path: filePath, imports });

  it("rejects undeclared and disallowed workspace imports", () => {
    const violations = checkWorkspace(
      baselineWorkspace([
        workspacePackage(scoped("application"), {}, [
          file("src/ingest.ts", [scoped("domain"), `${scoped("db")}/client`]),
        ]),
      ]),
    );

    expect(violations.map((violation) => [violation.kind, violation.file])).toEqual([
      ["undeclared-import", "packages/application/src/ingest.ts"],
      ["disallowed-workspace-import", "packages/application/src/ingest.ts"],
    ]);
  });

  it("rejects forbidden framework/infrastructure imports in core packages, including subpaths", () => {
    const violations = checkWorkspace(
      baselineWorkspace([
        workspacePackage(scoped("domain"), {}, [file("src/model.ts", ["next/server", "@prisma/client/runtime", "openai"])]),
        workspacePackage(scoped("channel-core"), {}, [file("src/contracts.test.ts", ["react"])]),
      ]),
    );

    expect(kinds(violations)).toEqual(["forbidden-import", "forbidden-import", "forbidden-import", "forbidden-import"]);
  });

  it("rejects Node.js built-ins in pure runtime code but allows them in tests and non-pure packages", () => {
    const violations = checkWorkspace(
      baselineWorkspace([
        workspacePackage(scoped("domain"), {}, [
          file("src/ids.ts", ["node:crypto"]),
          file("src/clock.ts", ["fs"]),
          file("src/ids.test.ts", ["node:crypto"]),
        ]),
        workspacePackage(scoped("application"), {}, [file("src/use-case.ts", ["node:crypto"])]),
      ]),
    );

    expect(violations.map((violation) => violation.file)).toEqual([
      "packages/domain/src/ids.ts",
      "packages/domain/src/clock.ts",
    ]);
    expect(kinds(violations)).toEqual(["node-builtin-in-pure-package", "node-builtin-in-pure-package"]);
  });

  it("requires runtime third-party imports to be production dependencies", () => {
    const violations = checkWorkspace(
      baselineWorkspace([
        workspacePackage(scoped("env"), { dependencies: { zod: "^4.0.0" }, devDependencies: { esbuild: "^0.28.0" } }, [
          file("src/parse.ts", ["zod", "zod/mini", "esbuild", "left-pad"]),
        ]),
      ]),
    );

    expect(violations.map((violation) => [violation.kind, violation.message.split('"')[1]])).toEqual([
      ["dev-dependency-in-runtime-code", "esbuild"],
      ["undeclared-import", "left-pad"],
    ]);
  });

  it("lets tests and tooling files use root devDependencies but not arbitrary packages", () => {
    const violations = checkWorkspace(
      baselineWorkspace([
        workspacePackage(scoped("worker"), { devDependencies: { esbuild: "^0.28.0" } }, [
          file("src/main.test.ts", ["vitest"]),
          file("build.ts", ["esbuild", "vitest"]),
          file("vitest.config.ts", ["left-pad"]),
        ]),
      ]),
      { rootDevDependencies: ["vitest", "typescript"] },
    );

    expect(violations.map((violation) => [violation.kind, violation.file])).toEqual([
      ["undeclared-import", "apps/worker/vitest.config.ts"],
    ]);
  });

  it("rejects relative imports that escape the package directory", () => {
    const violations = checkWorkspace(
      baselineWorkspace([
        workspacePackage(scoped("application"), {}, [
          file("src/a/b.ts", ["../c", "../../package.json", "../../../db/src/index"]),
          file("src/d.ts", ["/abs/path"]),
        ]),
      ]),
    );

    expect(violations.map((violation) => [violation.kind, violation.file])).toEqual([
      ["cross-package-relative-import", "packages/application/src/a/b.ts"],
      ["cross-package-relative-import", "packages/application/src/d.ts"],
    ]);
  });

  it("ignores subpath imports and self-references", () => {
    const violations = checkWorkspace(
      baselineWorkspace([workspacePackage(scoped("domain"), {}, [file("src/index.ts", ["#internal/ids", scoped("domain")])])]),
    );

    expect(violations).toEqual([]);
  });
});

describe("helpers", () => {
  it.each([
    ["zod", "zod"],
    ["zod/mini", "zod"],
    ["@prisma/client", "@prisma/client"],
    ["@prisma/client/runtime/library", "@prisma/client"],
  ])("packageNameOf(%s) = %s", (specifier, expected) => {
    expect(packageNameOf(specifier)).toBe(expected);
  });

  it.each([
    ["src/index.ts", true],
    ["src/nested/model.tsx", true],
    ["src/index.test.ts", false],
    ["src/model.spec.tsx", false],
    ["src/__tests__/model.ts", false],
    ["src/fixtures/webhook.ts", false],
    ["build.ts", false],
    ["next.config.ts", false],
  ])("isRuntimeSourceFile(%s) = %s", (filePath, expected) => {
    expect(isRuntimeSourceFile(filePath)).toBe(expected);
  });

  it("extracts static, type-only, re-export, dynamic and require specifiers", () => {
    const source = `
      import a from "a";
      import type { B } from "@scope/b";
      export * from "./c";
      export { d } from "d/sub";
      const e = await import("e");
      const f = require("f");
      import "side-effect";
    `;

    expect(extractImports(source)).toEqual(["a", "@scope/b", "./c", "d/sub", "e", "f", "side-effect"]);
  });
});

describe("repository workspace", () => {
  it("satisfies every architecture boundary rule", async () => {
    const rootDir = path.resolve(import.meta.dirname, "../..");
    const { packages, rootDevDependencies } = await loadWorkspace(rootDir);

    expect(packages.map((candidate) => candidate.name).sort()).toEqual(Object.keys(PACKAGE_RULES).sort());
    expect(checkWorkspace(packages, { rootDevDependencies })).toEqual([]);
  });
});
