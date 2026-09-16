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
  extra: Partial<Pick<WorkspacePackage, "tsconfigTypes" | "aliases" | "symlinks" | "nestedManifests" | "exportTargets">> = {},
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
  it("accepts the canonical layout with ADR-008/ADR-010-compliant edges (ai implements application ports)", () => {
    const violations = checkWorkspace(
      baselineWorkspace([
        workspacePackage(scoped("channel-core"), { dependencies: { [scoped("domain")]: "workspace:*" } }),
        workspacePackage(scoped("application"), {
          dependencies: { [scoped("domain")]: "workspace:*", [scoped("channel-core")]: "workspace:*" },
        }),
        workspacePackage(scoped("ai"), {
          dependencies: { [scoped("application")]: "workspace:*", [scoped("observability")]: "workspace:*" },
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
    ["application", "ai"],
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

  it.each([
    ["git URL", "git+https://github.com/WhiskeySockets/Baileys.git"],
    ["github shorthand protocol", "github:WhiskeySockets/Baileys"],
    ["user/repo shorthand", "WhiskeySockets/Baileys#main"],
    ["tarball URL", "https://registry.npmjs.org/baileys/-/baileys-6.7.18.tgz"],
    ["catalog", "catalog:"],
    ["jsr", "jsr:@std/path@^1.0.0"],
  ])("rejects a %s dependency whose installed package cannot be checked", (_label, spec) => {
    const violations = checkWorkspace(
      baselineWorkspace([workspacePackage(scoped("channel-whatsapp"), { dependencies: { "harmless-name": spec } })]),
    );

    expect(kinds(violations)).toEqual(["non-registry-dependency"]);
  });

  it("applies alias and non-registry checks to the root manifest", () => {
    const violations = checkWorkspace(baselineWorkspace(), {
      root: {
        manifest: {
          devDependencies: {
            "wa-local": "link:./vendor/baileys",
            "wa-file": "file:./vendor/whatsapp-web.js-1.0.0.tgz",
            "wa-git": "github:WhiskeySockets/Baileys",
            "wa-npm": "npm:baileys@^6.7.18",
          },
        },
        sourceFiles: [],
      },
    });

    expect(kinds(violations)).toEqual([
      "aliased-dependency",
      "aliased-dependency",
      "non-registry-dependency",
      "aliased-dependency",
      "forbidden-dependency",
    ]);
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
        workspacePackage(scoped("queue"), {}, [file("src/scheduler.ts", ["node:crypto"])]),
      ]),
    );

    expect(kindsAndFiles(violations)).toEqual([
      ["node-builtin-in-pure-package", "packages/domain/src/ids.ts"],
      ["node-builtin-in-pure-package", "packages/domain/src/clock.ts"],
      ["node-builtin-in-pure-package", "packages/application/src/use-case.ts"],
    ]);
  });

  it("rejects Node.js type definitions in pure packages via tsconfig or triple-slash references (tests included)", () => {
    const violations = checkWorkspace(
      baselineWorkspace([
        workspacePackage(scoped("channel-core"), {}, [], { tsconfigTypes: ["*"] }),
        workspacePackage(scoped("domain"), {}, [file("src/clock.ts", [], ["node"]), file("src/clock.test.ts", [], ["node/"])], {
          tsconfigTypes: ["@types/node/"],
        }),
        workspacePackage(scoped("queue"), {}, [file("src/index.ts", [], ["node"])], { tsconfigTypes: ["node"] }),
      ]),
    );

    expect(kindsAndFiles(violations)).toEqual([
      ["node-types-in-pure-package", "packages/domain/tsconfig.json"],
      ["node-types-in-pure-package", "packages/domain/src/clock.ts"],
      ["node-types-in-pure-package", "packages/domain/src/clock.test.ts"],
      ["node-types-in-pure-package", "packages/channel-core/tsconfig.json"],
    ]);
  });

  it("rejects runtime code reaching test, tooling or unscanned code through a local hop", () => {
    const violations = checkWorkspace(
      baselineWorkspace([
        workspacePackage(scoped("domain"), {}, [
          file("src/index.ts", [
            "./model.js",
            "../package.json",
            "./fixtures/ids",
            "./__tests__/proc",
            "./test-utils",
            "../lib/http",
            "../build/bridge",
            "../.internal/bridge",
            "./node_modules/index",
          ]),
          file("src/model.ts", []),
          file("src/fixtures/ids.ts", ["node:crypto"]),
          file("src/__tests__/proc.ts", []),
          file("src/test-utils.ts", []),
          file("lib/http.ts", []),
          file("src/index.test.ts", ["./fixtures/ids", "./test-utils"]),
        ]),
      ]),
    );

    expect(violations.map((violation) => [violation.kind, violation.message.split('"')[1]])).toEqual([
      ["runtime-import-of-non-runtime-code", "./fixtures/ids"],
      ["runtime-import-of-non-runtime-code", "./__tests__/proc"],
      ["runtime-import-of-non-runtime-code", "./test-utils"],
      ["runtime-import-of-non-runtime-code", "../lib/http"],
      ["runtime-import-of-non-runtime-code", "../build/bridge"],
      ["runtime-import-of-non-runtime-code", "../.internal/bridge"],
      ["runtime-import-of-non-runtime-code", "./node_modules/index"],
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
          file("src/c.ts", []),
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
          file("src/index.ts", ["#internal/ids", "#db/index", "#schema", "@/model", "#missing"]),
          file("src/internal/ids.ts", []),
          file("src/model.ts", []),
        ], { aliases }),
      ]),
    );

    expect(violations.map((violation) => [violation.kind, violation.message.split('"')[1]])).toEqual([
      ["cross-package-relative-import", "#db/index"],
      ["undeclared-import", "zod"],
      ["unresolved-alias-import", "#missing"],
    ]);
  });

  it("checks every matching alias, so a broad alias declared first cannot hide a specific one", () => {
    const violations = checkWorkspace(
      baselineWorkspace([
        workspacePackage(scoped("domain"), {}, [file("src/index.ts", ["@/infra/index", "#lib/store"]), file("src/infra/index.ts", []), file("src/store.ts", [])], {
          aliases: [
            { pattern: "#lib/*", targets: ["./src/*"] },
            { pattern: "#lib/store", targets: ["pg", "./src/store.ts"] },
            { pattern: "@/*", targets: ["./src/*"] },
            { pattern: "@/infra/*", targets: ["../db/src/*"] },
          ],
        }),
      ]),
    );

    expect(violations.map((violation) => [violation.kind, violation.message.split('"')[1]])).toEqual([
      ["cross-package-relative-import", "@/infra/index"],
      ["forbidden-import", "pg"],
    ]);
  });

  it("follows createRequire loaders under any name and reports untracked loader values", () => {
    const source = `
      import { createRequire as makeRequire } from "node:module";
      import * as nodeModule from "node:module";
      const load = makeRequire(import.meta.url);
      const other = nodeModule.createRequire(import.meta.url);
      export const browser: unknown = load("puppeteer");
      export const transport: unknown = other("baileys");
      export const resolved = load.resolve("./fixtures/helper");
      export const direct: unknown = makeRequire(import.meta.url)("left-pad");
      export const parenthesized: unknown = (load)("zod");
      export const computed = (name: string): unknown => load(name);
      export const escaped = { loader: makeRequire(import.meta.url) };
    `;

    expect(extractModuleReferences(source)).toMatchObject({
      imports: ["node:module", "node:module", "puppeteer", "baileys", "./fixtures/helper", "left-pad", "zod"],
      typeReferences: [],
      unresolvedModuleLoads: ["load(name)", "makeRequire(...) used as a value: loader: makeRequire(import.meta.url)"],
    });
  });

  it("reports loaders that escape direct invocation: aliases, objects, arguments, extracted members (R1-01 follow-up)", () => {
    const source = `
      import { createRequire } from "node:module";
      import * as nodeModule from "node:module";
      const load = createRequire(import.meta.url);
      const forwarded = load;
      forwarded("../../channel-whatsapp/src/index.ts");
      const holder = { load };
      const named = { loader: load };
      register(load);
      const resolveModule = load.resolve;
      load.call(undefined, "zod");
      const plainRequire = require;
      const factory = createRequire;
      const nsFactory = nodeModule.createRequire;
      const moduleRequire = module.require;
      const builtin = process.getBuiltinModule;
      export const ok = [load("zod"), load.resolve("zod"), typeof load, require("zod"), require.resolve("zod")];
      function register(fn: unknown): unknown { return fn; }
      const { resolve } = load;
      export { load, load as exportedLoader };
      export { createRequire as reexported } from "node:module";
    `;

    const { imports, unresolvedModuleLoads } = extractModuleReferences(source);

    expect(imports).toEqual(expect.arrayContaining(["zod"]));
    expect(unresolvedModuleLoads).toEqual([
      "load used as a value: forwarded = load",
      "load used as a value: load",
      "load used as a value: loader: load",
      "load used as a value: register(load)",
      "load.resolve used as a value: resolveModule = load.resolve",
      'load.call used as a value: load.call(undefined, "zod")',
      "require used as a value: plainRequire = require",
      "createRequire used as a value: factory = createRequire",
      "nodeModule.createRequire used as a value: nsFactory = nodeModule.createRequire",
      "module.require used as a value: moduleRequire = module.require",
      "process.getBuiltinModule used as a value: builtin = process.getBuiltinModule",
      "load used as a value: { resolve } = load",
      "load used as a value: load",
      "load used as a value: load as exportedLoader",
    ]);
  });

  it("normalizes bracket and globalThis member access for loaders and rejects computed members (R1-01 follow-up 2)", () => {
    const source = `
      import * as nodeModule from "node:module";
      import nodeModuleDefault from "node:module";
      const load = nodeModule["createRequire"](import.meta.url);
      void load("../../channel-whatsapp/src/index.ts");
      const load2 = nodeModuleDefault.default.createRequire(import.meta.url);
      load2(\`zod\`);
      module["require"]("left-pad");
      process["getBuiltinModule"]("fs");
      globalThis.process.getBuiltinModule("net");
      globalThis["process"]["getBuiltinModule"]("tls");
      const key = "getBuiltinModule";
      process[key]("dns");
      const { getBuiltinModule } = process;
      const { env, argv } = process;
      const { createRequire: cr } = await import("node:module");
      const load3 = cr(import.meta.url);
      load3("puppeteer");
      (await import("node:module")).createRequire(import.meta.url);
      const ns = await import("node:module");
      const load4 = ns.createRequire(import.meta.url);
      load4("baileys");
      export const fine = [process.env.X, process.on("SIGTERM", () => undefined), globalThis.crypto.randomUUID(), typeof require, require.cache];
      const aliasedProcess = process;
      Reflect.get(globalThis, "process");
    `;

    expect(extractModuleReferences(source)).toMatchObject({
      imports: [
        "node:module",
        "node:module",
        "../../channel-whatsapp/src/index.ts",
        "zod",
        "left-pad",
        "node:fs",
        "node:net",
        "node:tls",
        "node:module",
        "puppeteer",
        "node:module",
        "node:module",
        "baileys",
      ],
      typeReferences: [],
      unresolvedModuleLoads: [
        'process[computed] used as a value: process[key]("dns")',
        "process used as a value: { getBuiltinModule } = process",
        '(await import("node:module")).createRequire(...) used as a value: (await import("node:module")).createRequire(import.meta.url);',
        "process used as a value: aliasedProcess = process",
        'globalThis used as a value: Reflect.get(globalThis, "process")',
      ],
    });
  });

  it("tracks global self-references and dynamic code evaluation (R1-01 follow-up 3)", () => {
    const source = `
      globalThis.globalThis.process.getBuiltinModule("fs");
      globalThis["self"]["global"].process["getBuiltinModule"]("net");
      const name = "dns";
      globalThis.window.process.getBuiltinModule(name);
      const { globalThis: again } = globalThis;
      Function("return process")();
      new Function("return require");
      const F = Function;
      eval("require('fs')");
      (() => undefined).constructor("return process")();
      Object.getPrototypeOf(async () => undefined)["constructor"]("return process");
      export const fine = [typeof Function, typeof eval, globalThis.crypto];
      function annotated(callback: Function): Function { return callback; }
    `;

    const references = extractModuleReferences(source);

    expect(references.imports).toEqual(["node:fs", "node:net"]);
    expect(references.runtimeGlobals).toEqual(["globalThis"]);
    expect(references.unresolvedModuleLoads).toEqual([
      "globalThis.window.process.getBuiltinModule(name)",
      "globalThis used as a value: { globalThis: again } = globalThis",
      'dynamic code evaluation (Function): Function("return process")',
      'dynamic code evaluation (Function): new Function("return require")',
      "dynamic code evaluation (Function): F = Function",
      "dynamic code evaluation (eval): eval(\"require('fs')\")",
      'dynamic code evaluation (constructor call): (() => undefined).constructor("return process")',
      'dynamic code evaluation (constructor call): Object.getPrototypeOf(async () => undefined)["constructor"]("return process")',
    ]);
  });

  it("rejects escaping function constructors but allows safe constructor reads (R1-01 follow-up 4)", () => {
    const source = `
      const compile = (() => {}).constructor as (source: string) => () => boolean;
      const loaded = compile("return typeof process.getBuiltinModule('fs').readFileSync === 'function'")();
      const viaBracket = (async () => undefined)["con" + "structor"];
      const { constructor: destructured } = () => undefined;
      const { ["constructor"]: computedKey } = () => undefined;
      const fromReflect = Reflect.get(() => undefined, "constructor");
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(() => undefined), "constructor");
      register((() => undefined).constructor);
      function leak() { return (function* () {}).constructor; }
      export const fine = [
        loaded,
        viaBracket,
        destructured,
        computedKey,
        fromReflect,
        descriptor,
        ({}).constructor.name,
        ({}).constructor === Object,
        [] instanceof ([]).constructor,
        typeof (() => undefined).constructor,
      ];
      function register(value: unknown): unknown { return value; }
    `;

    expect(extractModuleReferences(source).unresolvedModuleLoads).toEqual([
      "dynamic code evaluation (constructor reference): compile = (() => {}).constructor as (source: string) => () => boolean",
      'dynamic code evaluation (constructor reference): viaBracket = (async () => undefined)["con" + "structor"]',
      "dynamic code evaluation (constructor destructuring): { constructor: destructured } = () => undefined",
      'dynamic code evaluation (constructor destructuring): { ["constructor"]: computedKey } = () => undefined',
      'dynamic code evaluation (constructor lookup): Reflect.get(() => undefined, "constructor")',
      'dynamic code evaluation (constructor lookup): Object.getOwnPropertyDescriptor(Object.getPrototypeOf(() => undefined), "constructor")',
      "dynamic code evaluation (constructor reference): register((() => undefined).constructor)",
      "dynamic code evaluation (constructor reference): return (function* () {}).constructor;",
    ]);
  });

  it("rejects the reviewer's constructor-alias fixture in a pure package through the real workspace (R1-01 follow-up 4)", async () => {
    const rootDir = path.resolve(import.meta.dirname, "../..");
    const source = `
      const compile = (() => {}).constructor as (source: string) => () => boolean;
      const loaded = compile("return typeof process.getBuiltinModule('fs').readFileSync === 'function'")();
      if (!loaded) throw new Error("Synthetic fs capability check failed");
    `;
    const { packages, root } = await loadWorkspace(rootDir);
    const modified = packages.map((candidate) =>
      candidate.name === scoped("application")
        ? { ...candidate, sourceFiles: [...candidate.sourceFiles, { path: "src/r1-constructor-alias.ts", ...extractModuleReferences(source) }] }
        : candidate,
    );

    expect(kindsAndFiles(checkWorkspace(modified, { root }))).toEqual([
      ["unresolvable-module-load", "packages/application/src/r1-constructor-alias.ts"],
    ]);
  });

  it("rejects the reviewer's global self-reference fixture in a pure package through the real workspace (R1-01 follow-up 3)", async () => {
    const rootDir = path.resolve(import.meta.dirname, "../..");
    const source = `
      const builtin = (
        globalThis as unknown as {
          globalThis: {
            process: {
              getBuiltinModule(name: string): unknown;
            };
          };
        }
      ).globalThis.process.getBuiltinModule("fs");

      void builtin;
    `;
    const { packages, root } = await loadWorkspace(rootDir);
    const modified = packages.map((candidate) =>
      candidate.name === scoped("application")
        ? { ...candidate, sourceFiles: [...candidate.sourceFiles, { path: "src/r1-global-self.ts", ...extractModuleReferences(source) }] }
        : candidate,
    );

    expect(checkWorkspace(modified, { root }).map((violation) => [violation.kind, violation.file, violation.message.split('"')[1]])).toEqual([
      ["node-builtin-in-pure-package", "packages/application/src/r1-global-self.ts", "node:fs"],
      ["node-builtin-in-pure-package", "packages/application/src/r1-global-self.ts", "globalThis"],
    ]);
  });

  it("rejects the reviewer's bracket-access loader fixture through the real workspace (R1-01 follow-up 2)", async () => {
    const rootDir = path.resolve(import.meta.dirname, "../..");
    const fixtures: Record<string, string> = {
      "src/r1-element-loader.ts": `
        import * as nodeModule from "node:module";
        const load = nodeModule["createRequire"](import.meta.url);
        void load("../../channel-whatsapp/src/index.ts");
      `,
      "src/r1-module-require.ts": 'module["require"]("../../channel-whatsapp/src/index.ts");',
      "src/r1-builtin.ts": 'process["getBuiltinModule"](["fs"].join(""));',
    };
    const { packages, root } = await loadWorkspace(rootDir);
    const modified = packages.map((candidate) =>
      candidate.name === scoped("ai")
        ? {
            ...candidate,
            sourceFiles: [
              ...candidate.sourceFiles,
              ...Object.entries(fixtures).map(([filePath, source]) => ({ path: filePath, ...extractModuleReferences(source) })),
            ],
          }
        : candidate,
    );

    expect(kindsAndFiles(checkWorkspace(modified, { root }))).toEqual([
      ["cross-package-relative-import", "packages/ai/src/r1-element-loader.ts"],
      ["cross-package-relative-import", "packages/ai/src/r1-module-require.ts"],
      ["unresolvable-module-load", "packages/ai/src/r1-builtin.ts"],
    ]);
  });

  it("rejects the reviewer's forwarded-loader fixture through the real workspace (R1-01 follow-up)", async () => {
    const rootDir = path.resolve(import.meta.dirname, "../..");
    const source = `
      import { createRequire } from "node:module";
      const load = createRequire(import.meta.url);
      const forwarded = load;
      forwarded("../../channel-whatsapp/src/index.ts");
    `;
    const { packages, root } = await loadWorkspace(rootDir);
    const modified = packages.map((candidate) =>
      candidate.name === scoped("ai")
        ? { ...candidate, sourceFiles: [...candidate.sourceFiles, { path: "src/r1-alias-review.ts", ...extractModuleReferences(source) }] }
        : candidate,
    );

    expect(kindsAndFiles(checkWorkspace(modified, { root }))).toEqual([
      ["unresolvable-module-load", "packages/ai/src/r1-alias-review.ts"],
    ]);
  });

  it("fails closed on computed module loads in any package file (R1-01)", () => {
    const refs = extractModuleReferences('export async function probe(): Promise<void> { await import("node:" + "fs"); }');
    const computed = extractModuleReferences("export const load = (target: string) => import(target);");
    const violations = checkWorkspace(
      baselineWorkspace([
        workspacePackage(scoped("application"), {}, [
          { path: "src/probe.ts", ...refs },
          { path: "src/loader.ts", ...computed },
          { path: "src/loader.test.ts", ...computed },
        ]),
      ]),
    );

    expect(kindsAndFiles(violations)).toEqual([
      ["node-builtin-in-pure-package", "packages/application/src/probe.ts"],
      ["unresolvable-module-load", "packages/application/src/loader.ts"],
      ["unresolvable-module-load", "packages/application/src/loader.test.ts"],
    ]);
  });

  it("rejects runtime JavaScript files in every package but allows JavaScript tooling outside src (R1-02)", () => {
    const violations = checkWorkspace(
      baselineWorkspace([
        workspacePackage(scoped("application"), {}, [
          file("src/r1-probe.ts", ["./r1-io.js"]),
          file("src/r1-io.js", []),
          file("src/legacy.mjs", []),
          file("src/helper.test.js", []),
        ]),
        workspacePackage(scoped("web"), {}, [file("postcss.config.mjs", [])]),
      ]),
    );

    expect(kindsAndFiles(violations)).toEqual([
      ["javascript-runtime-file", "packages/application/src/r1-io.js"],
      ["javascript-runtime-file", "packages/application/src/legacy.mjs"],
    ]);
  });

  it("resolves self-imports through package.json exports and fails closed otherwise (R1-02 follow-up)", () => {
    const violations = checkWorkspace(
      baselineWorkspace([
        workspacePackage(
          scoped("application"),
          {},
          [
            file("src/index.ts", [scoped("application"), `${scoped("application")}/io`, `${scoped("application")}/hidden`]),
            file("src/__tests__/io.config.js", []),
          ],
          {
            aliases: [
              { pattern: scoped("application"), targets: ["./src/index.ts"] },
              { pattern: `${scoped("application")}/io`, targets: ["./src/__tests__/io.config.js"] },
            ],
            exportTargets: ["./src/index.ts", "./src/__tests__/io.config.js"],
          },
        ),
      ]),
    );

    expect(violations.map((violation) => [violation.kind, violation.message.split('"')[1]])).toEqual([
      ["invalid-package-export", "./src/__tests__/io.config.js"],
      ["runtime-import-of-non-runtime-code", `${scoped("application")}/io`],
      ["unresolved-alias-import", `${scoped("application")}/hidden`],
    ]);
  });

  it("rejects nested manifests, query-suffixed hops and local module paths that resolve to no source file", () => {
    const violations = checkWorkspace(
      baselineWorkspace([
        workspacePackage(
          scoped("application"),
          {},
          [
            file("src/index.ts", ["./shim", "./__tests__/io.config.js?v=1", "./model%2Ets", "./styles.css", "./data.json"]),
            file("src/model.ts", []),
            file("src/__tests__/io.config.js", []),
          ],
          { nestedManifests: ["src/shim/package.json"] },
        ),
      ]),
    );

    expect(violations.map((violation) => [violation.kind, violation.file])).toEqual([
      ["nested-package-manifest", "packages/application/src/shim/package.json"],
      ["runtime-import-of-non-runtime-code", "packages/application/src/index.ts"],
      ["runtime-import-of-non-runtime-code", "packages/application/src/index.ts"],
    ]);
    expect(violations.slice(1).map((violation) => violation.message.split('"')[1])).toEqual([
      "./shim",
      "./__tests__/io.config.js?v=1",
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

    expect(extractModuleReferences(source)).toMatchObject({
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
      unresolvedModuleLoads: [],
    });
  });

  it("folds constant loader targets and reports computed ones instead of dropping them", () => {
    const source = `
      const base = "../../db/src";
      export async function probe(name: string): Promise<void> {
        await import("node:" + "fs");
        await import(\`node:\${"child_process"}\`);
        require(("../../" + "queue/src") as string);
        process.getBuiltinModule("net");
        await import(base);
        await import("node:" + name);
        await import(\`../../\${name}/src\`);
        module.require(name);
        process.getBuiltinModule(name);
      }
    `;

    expect(extractModuleReferences(source)).toMatchObject({
      imports: ["node:fs", "node:child_process", "../../queue/src", "node:net"],
      typeReferences: [],
      unresolvedModuleLoads: [
        "import(base)",
        'import("node:" + name)',
        "import(`../../${name}/src`)",
        "module.require(name)",
        "process.getBuiltinModule(name)",
      ],
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
    expect(root.sourceFiles).toEqual([
      { path: "scripts/tool.ts", imports: ["whatsapp-web.js"], typeReferences: [], unresolvedModuleLoads: [], runtimeGlobals: [] },
    ]);
  });

  it("reports symlinks even when they use names the scanner otherwise skips, and honours tsconfig baseUrl", async () => {
    const rootDir = await scaffold({
      "package.json": JSON.stringify({ name: "root" }),
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "packages/a/package.json": JSON.stringify({ name: "@x/a" }),
      "packages/a/tsconfig.json": JSON.stringify({
        compilerOptions: { ignoreDeprecations: "6.0", baseUrl: "..", paths: { "#infra/*": ["b/src/*"] } },
      }),
      "packages/a/src/index.ts": "export {};",
      "packages/b/package.json": JSON.stringify({ name: "@x/b" }),
      "packages/b/src/index.ts": "export {};",
    });
    const target = path.join(rootDir, "packages/b/src");
    await symlink(target, path.join(rootDir, "packages/a/src/node_modules"));
    await symlink(target, path.join(rootDir, "packages/a/dist"));
    await symlink(target, path.join(rootDir, "packages/a/.shared"));

    const { packages } = await loadWorkspace(rootDir);
    const a = packages.find((candidate) => candidate.name === "@x/a");

    expect(a?.symlinks?.slice().sort()).toEqual([".shared", "dist", "src/node_modules"]);
    expect(a?.aliases).toEqual([{ pattern: "#infra/*", targets: ["../b/src/*"] }]);
  });

  it("rejects the reviewer's two-file runtime JavaScript fixture end to end through the real loader (R1-02)", async () => {
    const rootDir = await scaffold({
      "package.json": JSON.stringify({ name: "root" }),
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "packages/application/package.json": JSON.stringify({ name: "@omnichannel/application" }),
      "packages/application/tsconfig.json": JSON.stringify({ compilerOptions: { types: [] }, include: ["src"] }),
      "packages/application/src/r1-probe.ts": 'import "./r1-io.js";\n',
      "packages/application/src/r1-io.js": "process.cwd();\n",
      "packages/application/src/r1-computed.ts": 'export async function probe(): Promise<void> { await import("node:" + "fs"); }\n',
    });

    const { packages, root } = await loadWorkspace(rootDir);
    const violations = checkWorkspace(packages, { root }).filter((violation) => violation.kind !== "missing-package");

    expect(kindsAndFiles(violations)).toEqual([
      ["node-builtin-in-pure-package", "packages/application/src/r1-computed.ts"],
      ["node-builtin-in-pure-package", "packages/application/src/r1-io.js"],
      ["javascript-runtime-file", "packages/application/src/r1-io.js"],
    ]);
  });

  it("rejects the exports self-import bypass end to end through the real loader (R1-02 follow-up)", async () => {
    const rootDir = await scaffold({
      "package.json": JSON.stringify({ name: "root" }),
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "packages/application/package.json": JSON.stringify({
        name: "@omnichannel/application",
        exports: { ".": "./src/index.ts", "./io": "./src/__tests__/io.config.js" },
      }),
      "packages/application/tsconfig.json": JSON.stringify({ compilerOptions: { types: [] }, include: ["src"] }),
      "packages/application/src/index.ts": 'export * from "./j1";\n',
      "packages/application/src/j1.ts": 'import { readSecret } from "@omnichannel/application/io";\nexport const j1 = () => readSecret();\n',
      "packages/application/src/__tests__/io.config.js": "export function readSecret() { return process.env.SYNTH_SECRET; }\n",
      "packages/application/src/shim/package.json": JSON.stringify({ main: "../__tests__/io.config.js" }),
    });

    const { packages, root } = await loadWorkspace(rootDir);
    const violations = checkWorkspace(packages, { root }).filter((violation) => violation.kind !== "missing-package");

    expect(kinds(violations).sort()).toEqual([
      "invalid-package-export",
      "nested-package-manifest",
      "runtime-import-of-non-runtime-code",
    ]);
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
