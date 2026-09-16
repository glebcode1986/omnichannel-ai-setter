# Omnichannel AI Setter

A multi-channel AI sales/support setter for Instagram and WhatsApp, designed as a SaaS product rather than a single-account bot.

## Product thesis

One AI brain, multiple messaging channels. Instagram and WhatsApp are adapters around a shared conversation engine, knowledge base, style memory, safety layer, delayed delivery engine, and human handoff workflow.

## MVP channels

- Instagram Messaging API
- WhatsApp Business Cloud API (official Meta API only)

Future channels should be addable through the same `ChannelAdapter` contract without rewriting the AI core.

## Core principles

1. **Channel-agnostic core** — no Instagram-specific business logic in the AI/domain layer.
2. **Official platform APIs in production** — no WhatsApp Web/Puppeteer/Baileys transport for the SaaS product.
3. **Human-like, not instant** — delayed replies with debounce, random delivery windows and revalidation before send.
4. **Human override always wins** — manual owner/agent activity pauses automation for that conversation.
5. **Fail safe** — uncertain, sensitive, ambiguous or unsupported cases are held for review.
6. **Persistent project memory** — architecture, decisions, research and implementation instructions live in this repository, not only in chat history.
7. **Agent-friendly development** — Claude/Codex/Astra should be able to continue from repository docs alone.

## Documentation map

- `PROJECT_CONTEXT.md` — canonical project memory and current state
- `CLAUDE.md` — implementation instructions for Claude
- `AGENTS.md` — rules for any coding agent (Claude, Codex, Astra, Cursor, etc.)
- `docs/specs/PRODUCT_REQUIREMENTS.md` — product requirements
- `docs/specs/ARCHITECTURE.md` — target architecture
- `docs/specs/TECHNICAL_SPEC.md` — technical specification
- `docs/specs/AI_BEHAVIOR.md` — AI behavior and safety contract
- `docs/specs/DELAY_ENGINE.md` — debounce / human-delay design
- `docs/specs/DATA_MODEL.md` — domain entities and persistence model
- `docs/research/OPEN_SOURCE_RESEARCH.md` — analyzed open-source references
- `docs/adr/` — architecture decision records
- `docs/specs/REPOSITORY_LAYOUT.md` — workspace packages, enforced dependency matrix and toolchain
- `docs/specs/CHANNEL_CONTRACTS.md` — `ChannelAdapter` boundary contracts
- `docs/specs/IMPLEMENTATION_PLAN.md` — Phase 1 issue plan and review protocol
- `docs/handoff/CURRENT_HANDOFF.md` — latest continuation point for a new chat/session
- `ROADMAP.md` — phased development plan

## Current status

Phase 1 (skeleton). The pnpm workspace, toolchain and runnable web/worker entrypoints exist (issue #2). Domain/channel contracts, persistence, queues and webhook ingestion are delivered by issues #3–#6; no product business logic exists yet.

## Development

### Prerequisites

- Node.js 24 (`nvm use` reads `.nvmrc`); `pnpm install` refuses other versions (`devEngines.runtime`).
- pnpm 12 via Corepack: `corepack enable` (the exact version is pinned by `packageManager` in `package.json`).

No database, Redis, Meta credentials or LLM keys are needed for the current scaffold.

### Setup

```bash
corepack enable
pnpm install
pnpm verify    # typecheck + lint + test + build — the pre-PR gate
```

### Workspace layout

```text
apps/web                     Next.js 16 dashboard + HTTP/webhook routes (composition root)
apps/worker                  long-running background worker process (composition root)
packages/domain              pure entities, value objects, policies, ports
packages/application         use cases / orchestration
packages/db                  Prisma/PostgreSQL persistence
packages/queue               BullMQ job contracts and scheduling primitives
packages/ai                  model providers, retrieval, structured generation
packages/channel-core        ChannelAdapter + normalized event/send contracts
packages/channel-instagram   Instagram adapter
packages/channel-whatsapp    WhatsApp Cloud API adapter
packages/observability       structured logging, correlation/audit helpers
packages/env                 environment validation (Zod)
scripts/architecture         dependency-boundary checker
```

Package names use the `@omnichannel/*` scope. Internal packages export TypeScript source directly (`exports: ./src/index.ts`); there is no per-package build step. See `docs/specs/REPOSITORY_LAYOUT.md` for conventions.

### Root scripts

| Command | What it does |
|---|---|
| `pnpm dev` | runs web (`next dev`, http://localhost:3000) and worker (`node --watch` + tsx loader) together |
| `pnpm dev:web` / `pnpm dev:worker` | runs one app |
| `pnpm build` | `next build` for web, esbuild bundle (`apps/worker/dist/main.js`) for worker |
| `pnpm typecheck` | `tsc --noEmit` in every package independently, then root tooling |
| `pnpm lint` | ESLint (type-aware, zero warnings) + `pnpm lint:boundaries` |
| `pnpm lint:boundaries` | fails on forbidden/undeclared/circular workspace dependencies (ADR-008) |
| `pnpm test` / `pnpm test:watch` | Vitest across all apps/packages and tooling |
| `pnpm verify` | typecheck, lint, test and build in sequence |

Per-package commands work with filters, e.g. `pnpm --filter @omnichannel/domain typecheck` or `pnpm --filter @omnichannel/worker test`.

### Running the apps

- Web: `pnpm dev:web`, then `GET http://localhost:3000/api/health` returns `{"status":"ok","service":"web"}`. Production: `pnpm --filter @omnichannel/web build && pnpm --filter @omnichannel/web start`.
- Worker: `pnpm dev:worker` logs `worker.started` as JSON and stops gracefully on `SIGINT`/`SIGTERM`. Production: `pnpm --filter @omnichannel/worker build && pnpm --filter @omnichannel/worker start`.

### Environment variables

Each app validates its environment once at startup through `@omnichannel/env`; invalid configuration fails with a message naming the schema-declared variable, the kind of failure and what the schema expects (allowed options, type, format, bounds), all derived from the schema definition; Zod issue messages, error maps and thrown exceptions are never copied, so values are not echoed.

- `apps/web/.env.example` → copy to `apps/web/.env.local` (loaded by Next.js).
- `apps/worker/.env.example` → copy to `apps/worker/.env` (loaded by `pnpm dev:worker`; `start` reads only the real process environment). Without that file Node prints `.env not found. Continuing without it.` — harmless.

Never commit real `.env` files, tokens or app secrets.

### Adding a dependency between packages

1. Check the allowed edge in `docs/specs/REPOSITORY_LAYOUT.md` (enforced by `scripts/architecture/rules.ts`).
2. `pnpm --filter @omnichannel/<consumer> add '@omnichannel/<provider>@workspace:*'` (quote the spec; zsh expands `*`)
3. Run `pnpm lint:boundaries`. Changing an allowed edge is an architecture change and needs a spec/ADR update.
