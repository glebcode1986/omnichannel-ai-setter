import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  checkWorkspace,
  findDependencyCycles,
  isRuntimeSourceFile,
  packageNameOf,
  type Manifest,
  type ModuleAlias,
  type SourceFile,
  type Violation,
  type WorkspacePackage,
} from "./check.ts";
import { PACKAGE_RULES, WORKSPACE_SCOPE, type PackageRule } from "./rules.ts";
import { extractModuleReferences, loadWorkspace } from "./workspace.ts";

const scoped = (name: string) => `${WORKSPACE_SCOPE}${name}`;

function workspacePackage(
  name: string,
  manifest: Manifest = {},
  sourceFiles: SourceFile[] = [],
  extra: Partial<Pick<WorkspacePackage, "tsconfigTypes" | "aliases" | "symlinks">> = {},
): WorkspacePackage {
  const shortName = name.replace(WORKSPACE_SCOPE, "");
  const dir = shortName === "web" || shortName === "worker" ? `apps/${shortName}` : `packages/${shortName}`;
  return { name, dir, manifest, sourceFiles, ...extra };
}

/** A valid workspace containing every package required by the rules, with no edges. */
function baselineWorkspace(overrides: WorkspacePackage[] = []): WorkspacePackage[] {
  const byName = new Map(Object.keys(PACKAGE_RULES).map((name) => [name, workspacePackage(name)]));
  for (const override of overrides) {
    byName.set(override.name, override);
  }
  return [...byName.values()];
}

const file = (filePath: string, imports: string[], typeReferences: string[] = []): SourceFile => ({
  path: filePath,
  imports,
  typeReferences,
});

const kinds = (violations: Violation[]) => violations.map((violation) => violation.kind);
const kindsAndFiles = (violations: Violation[]) => violations.map((violation) => [violation.kind, violation.file]);

describe("checkWorkspace: manifest rules", () => {
  it("accepts the canonical layout with ADR-008/ADR-010-compliant edges", () => {
    const violations = checkWorkspace(
      baselineWorkspace([
        workspacePackage(scoped("channel-core"), { dependencies: { [scoped("domain")]: "workspace:*" } }),
        workspacePackage(scoped("application"), {
          dependencies: {
            [scoped("domain")]: "workspace:*",
            [scoped("channel-core")]: "workspace:*",
            [scoped("ai")]: "workspace:*",
          },
        }),
        workspacePackage(scoped("db"), {
          dependencies: { [scoped("application")]: "workspace:*", "@prisma/client": "^7.0.0" },
        }),
        workspacePackage(scoped("channel-whatsapp"), { dependencies: { [scoped("channel-core")]: "workspace:^" } }),
        workspacePackage(scoped("worker"), {
          dependencies: { [scoped("queue")]: "workspace:*", [scoped("channel-instagram")]: "workspace:*" },
          devDependencies: { playwright: "^1.0.0" },
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
    ["ai", "application"],
    ["ai", "channel-instagram"],
    ["channel-instagram", "channel-whatsapp"],
    ["channel-whatsapp", "channel-instagram"],
    ["channel-instagram", "application"],
    ["db", "queue"],
    ["db", "ai"],
    ["observability", "domain"],
    ["env", "observability"],
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

  it("forbids browser automation outside devDependencies", () => {
    const violations = checkWorkspace(
      baselineWorkspace([
        workspacePackage(scoped("channel-whatsapp"), { dependencies: { puppeteer: "^24.0.0" } }),
        workspacePackage(scoped("worker"), { optionalDependencies: { "puppeteer-core": "^24.0.0" } }),
        workspacePackage(scoped("web"), { devDependencies: { playwright: "^1.0.0" } }),
      ]),
    );

    expect(violations.map((violation) => [violation.kind, violation.packageName])).toEqual([
      ["forbidden-dependency", scoped("channel-whatsapp")],
      ["forbidden-dependency", scoped("worker")],
    ]);
  });

  it("checks the root manifest and root tooling sources for rejected transports", () => {
    const violations = checkWorkspace(baselineWorkspace(), {
      root: {
        manifest: {
          devDependencies: { "@whiskeysockets/baileys": "^6.0.0", playwright: "^1.0.0" },
          dependencies: { puppeteer: "^24.0.0" },
        },
        sourceFiles: [file("scripts/wa.ts", ["whatsapp-web.js"])],
      },
    });

    expect(kinds(violations)).toEqual(["forbidden-dependency", "forbidden-dependency", "forbidden-import"]);
  });

  it.each([
    ["workspace alias", { jobs: "workspace:@omnichannel/queue@*" }, "@omnichannel/queue"],
    ["npm alias to a forbidden library", { orm: "npm:@prisma/client@^7.0.0" }, "@prisma/client"],
    ["link: protocol", { "db-link": "link:../db" }, "@omnichannel/db"],
    ["file: protocol", { "queue-file": "file:../queue" }, "@omnichannel/queue"],
    ["path-based workspace protocol", { [scoped("db")]: "workspace:../db" }, "@omnichannel/db"],
  ])("rejects a %s and still checks the real target", (_label, dependencies, target) => {
    const violations = checkWorkspace(baselineWorkspace([workspacePackage(scoped("application"), { dependencies })]));

    expect(kinds(violations)[0]).toBe("aliased-dependency");
    expect(violations.slice(1).map((violation) => violation.kind)).toEqual([
      target.startsWith(WORKSPACE_SCOPE) ? "disallowed-workspace-dependency" : "forbidden-dependency",
    ]);
    expect(violations.slice(1)[0]?.message).toContain(target);
  });

  it("rejects the same third-party package declared with different ranges", () => {
    const violations = checkWorkspace(
      baselineWorkspace([
        workspacePackage(scoped("queue"), { dependencies: { bullmq: "^5.1.0" } }),
        workspacePackage(scoped("worker"), { dependencies: { bullmq: "^5.2.0" } }),
        workspacePackage(scoped("env"), { dependencies: { zod: "^4.6.5" }, peerDependencies: { zod: "^4.0.0" } }),
      ]),
      { root: { manifest: { devDependencies: { tsx: "^4.23.13" } }, sourceFiles: [] } },
    );

    expect(kinds(violations)).toEqual(["inconsistent-dependency-version"]);
    expect(violations[0]?.message).toContain("bullmq");
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

  it("follows aliases when detecting cycles", () => {
    const packages = baselineWorkspace([
      workspacePackage(scoped("domain"), { dependencies: { db: "workspace:@omnichannel/db@*" } }),
      workspacePackage(scoped("db"), { dependencies: { [scoped("domain")]: "workspace:*" } }),
    ]);

    expect(findDependencyCycles(packages).map((violation) => violation.message)).toEqual([
      "Circular workspace dependency: @omnichannel/db -> @omnichannel/domain -> @omnichannel/db.",
    ]);
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
  it("rejects undeclared and disallowed workspace imports", () => {
    const violations = checkWorkspace(
      baselineWorkspace([
        workspacePackage(scoped("application"), {}, [
          file("src/ingest.ts", [scoped("domain"), `${scoped("db")}/client`]),
        ]),
      ]),
    );

    expect(kindsAndFiles(violations)).toEqual([
      ["undeclared-import", "packages/application/src/ingest.ts"],
      ["disallowed-workspace-import", "packages/application/src/ingest.ts"],
    ]);
  });

  it("rejects workspace packages that runtime code imports but only declares as devDependencies", () => {
    const violations = checkWorkspace(
      baselineWorkspace([
        workspacePackage(scoped("application"), { devDependencies: { [scoped("domain")]: "workspace:*" } }, [
          file("src/index.ts", [scoped("domain")]),
          file("src/index.test.ts", [scoped("domain")]),
        ]),
      ]),
    );

    expect(kindsAndFiles(violations)).toEqual([["dev-dependency-in-runtime-code", "packages/application/src/index.ts"]]);
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

  it("rejects browser automation imports from runtime code only", () => {
    const violations = checkWorkspace(
      baselineWorkspace([
        workspacePackage(scoped("web"), { devDependencies: { playwright: "^1.0.0" } }, [
          file("src/scrape.ts", ["playwright"]),
          file("src/e2e.test.ts", ["playwright"]),
        ]),
      ]),
    );

    expect(kindsAndFiles(violations)).toEqual([["forbidden-import", "apps/web/src/scrape.ts"]]);
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

    expect(kindsAndFiles(violations)).toEqual([
      ["node-builtin-in-pure-package", "packages/domain/src/ids.ts"],
      ["node-builtin-in-pure-package", "packages/domain/src/clock.ts"],
    ]);
  });

  it("rejects Node.js type definitions in pure packages via tsconfig or triple-slash references", () => {
    const violations = checkWorkspace(
      baselineWorkspace([
        workspacePackage(scoped("channel-core"), {}, [], { tsconfigTypes: ["node"] }),
        workspacePackage(scoped("domain"), {}, [file("src/clock.ts", [], ["node"]), file("src/clock.test.ts", [], ["node"])], {
          tsconfigTypes: [],
        }),
        workspacePackage(scoped("queue"), {}, [file("src/index.ts", [], ["node"])], { tsconfigTypes: ["node"] }),
      ]),
    );

    expect(kindsAndFiles(violations)).toEqual([
      ["node-types-in-pure-package", "packages/domain/src/clock.ts"],
      ["node-types-in-pure-package", "packages/channel-core/tsconfig.json"],
    ]);
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
      { root: { manifest: { devDependencies: { vitest: "^5.0.0", typescript: "~6.0.3" } }, sourceFiles: [] } },
    );

    expect(kindsAndFiles(violations)).toEqual([["undeclared-import", "apps/worker/vitest.config.ts"]]);
  });

  it("rejects relative imports that escape the package directory, including reference paths", () => {
    const violations = checkWorkspace(
      baselineWorkspace([
        workspacePackage(scoped("application"), {}, [
          file("src/a/b.ts", ["../c", "../../package.json", "../../../db/src/index"]),
          file("src/d.ts", ["/abs/path"]),
          file("src/e.ts", ["..\\..\\db\\src\\index"]),
        ]),
      ]),
    );

    expect(kindsAndFiles(violations)).toEqual([
      ["cross-package-relative-import", "packages/application/src/a/b.ts"],
      ["cross-package-relative-import", "packages/application/src/d.ts"],
      ["invalid-import-specifier", "packages/application/src/e.ts"],
    ]);
  });

  it("resolves package.json imports and tsconfig paths aliases instead of trusting them", () => {
    const aliases: ModuleAlias[] = [
      { pattern: "#internal/*", targets: ["./src/internal/*"] },
      { pattern: "#db/*", targets: ["../db/src/*"] },
      { pattern: "#schema", targets: ["zod"] },
      { pattern: "@/*", targets: ["./src/*"] },
    ];
    const violations = checkWorkspace(
      baselineWorkspace([
        workspacePackage(scoped("domain"), {}, [
          file("src/index.ts", ["#internal/ids", "#db/index", "#schema", "@/model", "#missing", scoped("domain")]),
        ], { aliases }),
      ]),
    );

    expect(violations.map((violation) => [violation.kind, violation.message.split('"')[1]])).toEqual([
      ["cross-package-relative-import", "#db/index"],
      ["undeclared-import", "zod"],
      ["unresolved-alias-import", "#missing"],
    ]);
  });

  it("rejects specifiers that are not valid package names when no alias defines them", () => {
    const violations = checkWorkspace(
      baselineWorkspace([workspacePackage(scoped("web"), {}, [file("src/app/page.tsx", ["@/lib/site"])])]),
    );

    expect(kinds(violations)).toEqual(["invalid-import-specifier"]);
  });

  it("rejects symbolic links inside packages", () => {
    const violations = checkWorkspace(
      baselineWorkspace([workspacePackage(scoped("domain"), {}, [], { symlinks: ["src/persistence"] })]),
    );

    expect(kindsAndFiles(violations)).toEqual([["symlink-in-package", "packages/domain/src/persistence"]]);
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
    ["src/index.d.ts", true],
    ["src/build/prompt.ts", true],
    ["src/conversation/fixtures/ids.ts", true],
    ["src/index.test.ts", false],
    ["src/model.spec.tsx", false],
    ["src/ids.test-d.ts", false],
    ["src/ranking.bench.ts", false],
    ["src/vitest.setup.ts", false],
    ["src/test-utils.ts", false],
    ["src/__tests__/model.ts", false],
    ["src/conversation/__fixtures__/ids.ts", false],
    ["src/fixtures/webhook.ts", false],
    ["src/testing/factories.ts", false],
    ["build.ts", false],
    ["next.config.ts", false],
  ])("isRuntimeSourceFile(%s) = %s", (filePath, expected) => {
    expect(isRuntimeSourceFile(filePath)).toBe(expected);
  });

  it("extracts every module-reference form from the AST", () => {
    const source = `
      /// <reference path="../../db/src/types.d.ts" />
      /// <reference types="node" />
      import a from "a";
      import type { B } from "@scope/b";
      export * from "./c";
      export * as ns from "ns-reexport";
      export type * as T from "type-ns-reexport";
      export { d } from "d/sub";
      import legacy = require("legacy");
      type Lazy = typeof import("lazy-type");
      const e = await import("e");
      const f = require("f");
      const g = require.resolve("g");
      import "side-effect";
      const text = 'import fake from "not-an-import"';
    `;

    expect(extractModuleReferences(source)).toEqual({
      imports: [
        "../../db/src/types.d.ts",
        "a",
        "@scope/b",
        "./c",
        "ns-reexport",
        "type-ns-reexport",
        "d/sub",
        "legacy",
        "lazy-type",
        "e",
        "f",
        "g",
        "side-effect",
      ],
      typeReferences: ["node"],
    });
  });

  it("does not treat import-like JSX text as an import", () => {
    const source = `export const Page = () => <pre>import x from "@omnichannel/worker";</pre>;`;

    expect(extractModuleReferences(source, "page.tsx").imports).toEqual([]);
  });
});

describe("loadWorkspace", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  async function scaffold(files: Record<string, string>): Promise<string> {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "boundaries-"));
    for (const [relativePath, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(tempDir, relativePath)), { recursive: true });
      await writeFile(path.join(tempDir, relativePath), content);
    }
    return tempDir;
  }

  it("scans nested build-like directories, hand-written .d.ts files and root scripts; reports symlinks", async () => {
    const rootDir = await scaffold({
      "package.json": JSON.stringify({ name: "root", devDependencies: { vitest: "^5.0.0" } }),
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n\nallowBuilds:\n  esbuild: true\n",
      "scripts/tool.ts": 'import "whatsapp-web.js";',
      "packages/a/package.json": JSON.stringify({ name: "@x/a", imports: { "#lib/*": "./src/lib/*" } }),
      "packages/a/tsconfig.json": JSON.stringify({ compilerOptions: { types: ["node"], paths: { "@/*": ["./src/*"] } } }),
      "packages/a/src/build/prompt.ts": 'export * as db from "@x/b";',
      "packages/a/src/ports.d.ts": 'import type { Job } from "bullmq";',
      "packages/a/dist/index.js": 'import "ignored-build-output";',
      "packages/a/next-env.d.ts": '/// <reference types="next" />',
      "packages/b/package.json": JSON.stringify({ name: "@x/b" }),
    });
    await symlink(path.join(rootDir, "packages/b"), path.join(rootDir, "packages/a/src/linked"));

    const { packages, root } = await loadWorkspace(rootDir);
    const a = packages.find((candidate) => candidate.name === "@x/a");

    expect(a?.sourceFiles.map((sourceFile) => [sourceFile.path, sourceFile.imports])).toEqual([
      ["src/build/prompt.ts", ["@x/b"]],
      ["src/ports.d.ts", ["bullmq"]],
    ]);
    expect(a?.symlinks).toEqual(["src/linked"]);
    expect(a?.tsconfigTypes).toEqual(["node"]);
    expect(a?.aliases).toEqual([
      { pattern: "#lib/*", targets: ["./src/lib/*"] },
      { pattern: "@/*", targets: ["./src/*"] },
    ]);
    expect(root.sourceFiles).toEqual([{ path: "scripts/tool.ts", imports: ["whatsapp-web.js"], typeReferences: [] }]);
  });

  it("fails loudly on a malformed package.json instead of skipping the package", async () => {
    const rootDir = await scaffold({
      "package.json": JSON.stringify({ name: "root" }),
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "packages/broken/package.json": '{ "name": "@x/broken",, }',
    });

    await expect(loadWorkspace(rootDir)).rejects.toThrow(/Cannot parse .*packages\/broken\/package\.json/);
  });
});

describe("repository workspace", () => {
  it("satisfies every architecture boundary rule", async () => {
    const rootDir = path.resolve(import.meta.dirname, "../..");
    const { packages, root } = await loadWorkspace(rootDir);

    expect(packages.map((candidate) => candidate.name).sort()).toEqual(Object.keys(PACKAGE_RULES).sort());
    expect(checkWorkspace(packages, { root })).toEqual([]);
  });
});
