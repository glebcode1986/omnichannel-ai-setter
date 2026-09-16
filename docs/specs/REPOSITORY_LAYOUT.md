# Repository Layout — v0.2

Canonical Phase-1 layout (scaffolded by issue #2):

```text
apps/
  web/                 # @omnichannel/web
  worker/              # @omnichannel/worker
packages/
  domain/              # @omnichannel/domain
  application/         # @omnichannel/application
  db/                  # @omnichannel/db
  queue/               # @omnichannel/queue
  ai/                  # @omnichannel/ai
  channel-core/        # @omnichannel/channel-core
  channel-instagram/   # @omnichannel/channel-instagram
  channel-whatsapp/    # @omnichannel/channel-whatsapp
  observability/       # @omnichannel/observability
  env/                 # @omnichannel/env
scripts/
  architecture/        # workspace boundary checker (pnpm lint:boundaries)
docs/
  adr/
  handoff/
  research/
  specs/
```

`packages/env` was added by issue #2 ("environment validation package/helper"). It is an infrastructure-free leaf used only by the app composition roots.

## Ownership guidance

- `domain`: pure TypeScript; no React, Prisma, BullMQ, Meta SDK/API, LLM provider or Node.js built-in imports.
- `application`: use cases, orchestration and the ports infrastructure implements (including the provider-neutral AI ports and model-output boundary schemas); pure and runtime-agnostic.
- `db`: Prisma schema/client/repositories/transaction helpers only.
- `queue`: BullMQ job names/payload schemas/producers/worker bootstrap helpers.
- `ai`: model-provider implementations of application-owned AI ports; provider SDKs stay private to it; never sends channel messages.
- `channel-core`: public channel boundary types/contracts.
- channel packages: Meta HTTP/webhook implementation and provider mapping only.
- `observability`: correlation IDs, structured logs, audit helpers.
- `env`: environment-variable validation helpers (Zod); apps validate once at startup and pass typed config inward.
- `apps/web`: dashboard, auth/session, API/webhook entry points and composition root.
- `apps/worker`: long-running processors and composition root.

## Import rule

Composition happens at app edges. Infrastructure packages implement core ports; core packages must not import concrete infrastructure.

## Enforced dependency matrix

ADR-008's dependency direction is enforced mechanically by `pnpm lint:boundaries` (part of `pnpm lint`). The source of truth is `scripts/architecture/rules.ts`; any change to an allowed edge must update this table in the same PR.

| Package | Layer | May depend on (workspace) |
|---|---|---|
| `domain` | core (pure) | — |
| `channel-core` | core (pure) | `domain` |
| `application` | core (pure) | `domain`, `channel-core` |
| `db`, `queue`, `ai` | infrastructure | `domain`, `channel-core`, `application` (ports), `observability` |
| `channel-instagram`, `channel-whatsapp` | channel adapter | `domain`, `channel-core`, `observability` |
| `observability`, `env` | support (leaf) | — |
| `web`, `worker` | app (composition root) | any non-app package |

Infrastructure implements ports that `application` declares; `application` never imports concrete infrastructure. For AI (ADR-010 as amended by the PR #26 architecture review): `application` owns the provider-neutral `ReplyModel` / `EmbeddingProvider` ports and the runtime boundary schema/DTO that validates model output, and maps validated output into pure `domain` values; `packages/ai` implements those ports and keeps provider SDKs private; `domain` holds only semantic types (e.g. `AiDraft`) with no provider DTOs. `db -> ai` is forbidden: application orchestrates embedding generation and passes vectors/query inputs to `db` retrieval. `application -> observability` is forbidden: pass correlation IDs as values, and if a use case needs logging, define/inject a core port.

Additional checks:

- dependency edges are read from `dependencies`, `devDependencies`, `peerDependencies` and `optionalDependencies`; internal packages must be declared by name with the `workspace:` protocol; aliases (`workspace:<name>@…`, `npm:`) and local-path protocols (`link:`, `file:`, `portal:`, `workspace:../path`) are rejected and their real targets are still checked;
- circular workspace dependencies fail (pnpm itself only warns);
- every workspace package must have a rule, and every package in the table must exist;
- a third-party package must use the same version range everywhere it is declared (root included; `peerDependencies` exempt), so a package cannot run against one version in tests and another inside an app bundle;
- source imports of workspace packages must be allowed **and** declared; runtime code (`src/**`, excluding tests, `__tests__`-style directories, and `test(s)/testing/fixtures` directly under `src/`) may import only production dependencies — workspace packages included — and may not reach test, tooling or unscanned files (top-level dot/`dist`/`out`/`build`/`coverage` directories, `node_modules`) through local imports;
- third-party dependencies must be registry ranges or dist-tags; git/tarball URLs, `github:`/`jsr:`/`catalog:` specifiers and `user/repo` shorthands are rejected because the installed package cannot be checked (extend the checker before adopting pnpm catalogs);
- relative imports and `/// <reference path>` may not escape their package directory; package.json `imports` and tsconfig `paths` aliases (every matching pattern, `baseUrl` honoured) are resolved and checked the same way; backslash specifiers and symlinks inside packages (whatever their name) are rejected;
- imports are read from the TypeScript AST (including `export * as`, `import x = require()`, `import()` type queries and hand-written `.d.ts` files);
- core packages (`domain`, `channel-core`, `application`) may not depend on or import persistence, queue/Redis, React/Next/Auth.js, LLM-provider or Meta SDK libraries;
- pure packages (`domain`, `channel-core`, `application`) may not import Node.js built-ins from runtime code, load Node.js types in any file (tsconfig `types` containing `node`, `@types/node` or `*`, or `/// <reference types="node" />` — tests share the package program), or use Node.js globals such as `process`/`Buffer` (ESLint `no-restricted-globals`);
- no package and not the root manifest/`scripts/` may depend on unofficial WhatsApp/Instagram transports (Baileys, whatsapp-web.js, instagram-private-api, …) per ADR-002; browser automation (Puppeteer, Playwright, Selenium) is allowed only as a devDependency used from tests/tooling.

The denylists are best-effort guards for known libraries, not a proof of compliance; reviews still apply.

A second, independent guard comes from pnpm's isolated `node_modules`: each package's `tsc --noEmit` can only resolve workspace packages it declares, so an undeclared import fails that package's `typecheck`.

## Package conventions

- Internal packages are **source-first**: `"exports": { ".": "./src/index.ts" }`, ESM (`"type": "module"`), no per-package build step. Consumers compile them: Next.js via `transpilePackages`, the worker via its esbuild bundle, Vitest/tsx natively.
- Every package has `typecheck` (`tsc --noEmit` against its own `tsconfig.json`, extending `tsconfig.base.json`) and `test` (`vitest run`) scripts. Root `pnpm typecheck` runs each package independently, then type-checks root tooling (`scripts/`, `vitest.config.ts`, `eslint.config.js`).
- Tests live next to code as `*.test.ts`. Root `vitest.config.ts` runs every app/package as a Vitest project plus the `tooling` project for `scripts/`.
- `tsconfig.base.json` enables `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noImplicitReturns`, `noUnusedLocals/Parameters` and `verbatimModuleSyntax`, and sets `types: []`. Pure packages (`domain`, `channel-core`, `application`) keep `types: []` and may only depend on each other; every other package sets `types: ["node"]`, because source-first dependencies are type-checked inside the consumer's program and allowed edges reach Node-typed code (e.g. `ai -> observability`).
- ESLint (flat config, `eslint.config.js`) uses type-aware `typescript-eslint` rules including `switch-exhaustiveness-check` for discriminated unions and `no-floating-promises`; Next.js/React-hooks rules apply to `apps/web`.
- The worker runs in development with `node --watch --import tsx` (graceful shutdown survives Ctrl+C; `tsx watch` force-kills a slow shutdown) and in production from the esbuild bundle. Dependencies that are native/wasm-heavy or read files relative to their own location must be declared in `apps/worker` `dependencies` so they stay external.

## Toolchain (pinned in Phase 1)

- Node.js 24 (`.nvmrc`); `devEngines.runtime` `^24.0.0` with `onFail: "error"` makes pnpm refuse to install on another version (`engines.node` is informational — pnpm does not enforce a project's own `engines`), pnpm 12 via Corepack (`packageManager`).
- TypeScript 6.0 — TypeScript 7 (native) is not yet supported by `typescript-eslint`'s type-aware linting.
- Next.js 16 / React 19, Vitest 5 (+ Vite 8 peer), ESLint 10, Zod 4, tsx, esbuild.
- `engineStrict` rejects dependencies whose `engines` exclude the running Node.js; dependency lifecycle scripts are blocked unless approved under `allowBuilds` in `pnpm-workspace.yaml`.

## Phase-1 bootstrap

Use pnpm workspace, shared TypeScript config and lint/test tooling. Do not introduce Turborepo unless build performance/CI later justifies it.
