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
- `application`: use cases and ports; coordinates state transitions.
- `db`: Prisma schema/client/repositories/transaction helpers only.
- `queue`: BullMQ job names/payload schemas/producers/worker bootstrap helpers.
- `ai`: provider adapters, retrieval and structured draft generation; never sends channel messages.
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
| `application` | core | `domain`, `channel-core` |
| `db`, `queue`, `ai` | infrastructure | `domain`, `channel-core`, `application` (ports), `observability` |
| `channel-instagram`, `channel-whatsapp` | channel adapter | `domain`, `channel-core`, `observability` |
| `observability`, `env` | support (leaf) | — |
| `web`, `worker` | app (composition root) | any non-app package |

Additional checks:

- dependency edges are read from `dependencies`, `devDependencies`, `peerDependencies` and `optionalDependencies`; internal packages must use the `workspace:` protocol;
- circular workspace dependencies fail (pnpm itself only warns);
- every workspace package must have a rule, and every package in the table must exist;
- source imports of workspace packages must be allowed **and** declared;
- runtime code (`src/**`, excluding tests/fixtures) may import only production dependencies; tests and tooling files may also use root devDependencies;
- relative imports may not escape their package directory;
- core packages (`domain`, `channel-core`, `application`) may not depend on or import persistence, queue/Redis, React/Next/Auth.js, LLM-provider or Meta SDK libraries;
- pure packages (`domain`, `channel-core`) may not import Node.js built-ins from runtime code;
- no package may depend on unofficial WhatsApp/Instagram transports (Baileys, whatsapp-web.js, instagram-private-api, …) per ADR-002.

A second, independent guard comes from pnpm's isolated `node_modules`: each package's `tsc --noEmit` can only resolve workspace packages it declares, so an undeclared import fails that package's `typecheck`.

## Package conventions

- Internal packages are **source-first**: `"exports": { ".": "./src/index.ts" }`, ESM (`"type": "module"`), no per-package build step. Consumers compile them: Next.js via `transpilePackages`, the worker via its esbuild bundle, Vitest/tsx natively.
- Every package has `typecheck` (`tsc --noEmit` against its own `tsconfig.json`, extending `tsconfig.base.json`) and `test` (`vitest run`) scripts. Root `pnpm typecheck` runs each package independently.
- Tests live next to code as `*.test.ts`. Root `vitest.config.ts` runs every app/package as a Vitest project plus the `tooling` project for `scripts/`.
- `tsconfig.base.json` enables `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noImplicitReturns`, `noUnusedLocals/Parameters` and `verbatimModuleSyntax`, and sets `types: []`; packages that run on Node.js opt into `types: ["node"]` explicitly.
- ESLint (flat config, `eslint.config.js`) uses type-aware `typescript-eslint` rules including `switch-exhaustiveness-check` for discriminated unions and `no-floating-promises`; Next.js/React-hooks rules apply to `apps/web`.

## Toolchain (pinned in Phase 1)

- Node.js 24 LTS (`.nvmrc`, `engines`), pnpm 12 via Corepack (`packageManager`).
- TypeScript 6.0 — TypeScript 7 (native) is not yet supported by `typescript-eslint`'s type-aware linting.
- Next.js 16 / React 19, Vitest 5 (+ Vite 8 peer), ESLint 10, Zod 4, tsx, esbuild.
- Dependency lifecycle scripts are blocked unless approved under `allowBuilds` in `pnpm-workspace.yaml`.

## Phase-1 bootstrap

Use pnpm workspace, shared TypeScript config and lint/test tooling. Do not introduce Turborepo unless build performance/CI later justifies it.
