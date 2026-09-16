# Task Contract — P1-01 Claude

**Executor:** Claude Code  
**Issue:** #2 `[P1-01] Scaffold pnpm workspace and baseline tooling`  
**Branch:** `feat/p1-01-project-skeleton`  
**Merge authority:** Human/project owner after independent review; Claude must not merge its own PR.

## Mandatory reading order

1. `PROJECT_CONTEXT.md`
2. `docs/handoff/CURRENT_HANDOFF.md`
3. `AGENTS.md`
4. `CLAUDE.md`
5. `docs/adr/ADR-008-pnpm-workspace-layout.md`
6. `docs/specs/REPOSITORY_LAYOUT.md`
7. `docs/specs/IMPLEMENTATION_PLAN.md`
8. GitHub Issue #2

Read Phase 2 specs only for awareness; do not implement Phase 2 work in this task.

## Objective

Create the clean Phase 1 monorepo/tooling skeleton required by Issue #2 so later domain, DB, queue and adapter work can be implemented without changing foundational project layout.

## Allowed scope

Create/configure only the scaffolding and baseline tooling required for Issue #2, including:

- root pnpm workspace configuration;
- `apps/web` minimal runnable Next.js application;
- `apps/worker` minimal runnable Node/TypeScript worker entrypoint;
- package directories required by `REPOSITORY_LAYOUT.md`;
- shared TypeScript configuration;
- strict TypeScript settings;
- ESLint baseline;
- Vitest baseline;
- environment validation helper/package as specified;
- root scripts for install/dev/build/typecheck/lint/test;
- minimal README/developer setup updates necessary to run the skeleton.

## Explicitly forbidden in this task

Do not implement:

- domain entities/contracts from #3;
- Prisma schema/auth/workspace persistence from #4;
- Redis/BullMQ behavior from #5;
- webhook ingestion from #6;
- Instagram/WhatsApp adapters;
- AI provider code/retrieval/policy/delivery;
- production Meta credentials or live API calls;
- opportunistic UI/product features;
- Turborepo unless the issue/spec is amended first.

Do not change accepted ADRs silently. If the scaffold exposes a genuine contradiction, stop that sub-part and document the conflict in the PR instead of inventing a replacement architecture.

## Required package directories

- `apps/web`
- `apps/worker`
- `packages/domain`
- `packages/application`
- `packages/db`
- `packages/queue`
- `packages/ai`
- `packages/channel-core`
- `packages/channel-instagram`
- `packages/channel-whatsapp`
- `packages/observability`

Empty packages may contain only the minimum files needed for workspace/typecheck/build integrity. Do not pre-implement future issue logic.

## Dependency-boundary expectations

Preserve ADR-008 direction. In particular, pure core packages must not become dependent on Next.js, Prisma, Meta SDKs or provider SDKs during scaffolding.

## Required verification before PR

From a clean checkout/state, run and report:

- `pnpm install`
- root typecheck
- root lint
- root test
- relevant build command(s)
- minimal start/dev verification for `apps/web`
- minimal independent start verification for `apps/worker`

If exact script names differ because the scaffold defines them, list the exact commands used.

## Acceptance checklist

- [ ] clean pnpm install succeeds
- [ ] root strict TypeScript typecheck succeeds
- [ ] lint succeeds
- [ ] Vitest baseline succeeds
- [ ] web app is minimally runnable
- [ ] worker is independently runnable
- [ ] all required packages exist
- [ ] no circular workspace dependency introduced
- [ ] no production secrets/credentials committed
- [ ] no future issue business logic implemented
- [ ] README/dev setup reflects actual commands
- [ ] `docs/handoff/CURRENT_HANDOFF.md` updated only if implementation state materially changed

## PR requirements

Open a PR into `main` referencing `Closes #2` or otherwise clearly linking Issue #2.

PR body must include:

1. summary of scaffold created;
2. exact commands run and results;
3. files/packages created;
4. any deviations from the issue/spec and why;
5. any architecture ambiguity discovered;
6. statement that no Phase 2 code or real Meta integration was added.

Do not merge the PR.

## Reviewer handoff

After the PR is open, the next step is independent Issue #7 review by Codex/Astra plus ChatGPT architecture review. Claude should respond to review findings on the same branch/PR, not start Issue #3 until #2 is accepted/merged.
