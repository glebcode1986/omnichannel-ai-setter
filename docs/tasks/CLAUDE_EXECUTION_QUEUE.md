# Claude Execution Queue

> Stable handoff page for the human programmer supervising Claude. Always read this file together with the linked task contract and GitHub issue. Chat history is not the execution source of truth.

## Current task — RUNNING / FIRST

### P1-01 — Issue #2: Scaffold pnpm workspace and baseline tooling

Contract: [`P1-01_CLAUDE_TASK_CONTRACT.md`](./P1-01_CLAUDE_TASK_CONTRACT.md)

Branch expected: `feat/p1-01-project-skeleton`

Status rule: Claude implements #2, runs required checks and opens a PR. Claude does **not** merge its own PR.

Before advancing: #2 PR must be reviewed against its acceptance criteria and accepted/merged into `main`.

## Next task — READY AFTER #2 MERGE

### P1-02 — Issue #3: Domain model and channel contracts

Contract: [`P1-02_CLAUDE_TASK_CONTRACT.md`](./P1-02_CLAUDE_TASK_CONTRACT.md)

Branch: `feat/p1-02-domain-channel-contracts`

**Do not start this task from the pre-#2 main branch.** Start from updated `main` only after #2 is accepted/merged.

Supervisor launch instruction for Claude:

```text
Open repository glebcode1986/omnichannel-ai-setter.
Pull the latest main after Issue #2 has been accepted and merged.
Read docs/tasks/P1-02_CLAUDE_TASK_CONTRACT.md and execute it exactly.
Implement only GitHub Issue #3 on branch feat/p1-02-domain-channel-contracts.
Run every verification required by the contract and open a PR into main.
Do not merge the PR and do not begin Issue #4 or #5.
```

## Queue after P1-02

1. P1-03 / #4 — Prisma + Auth.js + workspace isolation (`P1-03_CLAUDE_TASK_CONTRACT.md`).
2. P1-04 / #5 — BullMQ durable queue/delay primitives (`P1-04_CLAUDE_TASK_CONTRACT.md`). May proceed in parallel with #4 only after #3/shared IDs are stable and separate agents do not edit the same modules.
3. P1-05 / #6 — channel-neutral webhook ingestion (`P1-05_CLAUDE_TASK_CONTRACT.md`) after #3/#4/#5.
4. R1 / #7 — independent Codex/Astra review throughout Phase 1.

## Phase 2 gate — Instagram + shared AI

Do **not** start merely because contracts exist. Phase 2 starts after Phase 1 exit criteria unless architecture is explicitly amended. Contracts: `docs/tasks/P2-*`.

## Phase 4 gate — WhatsApp

Phase 4 contracts are prepared under `docs/tasks/P4-*`. ADR-016 is Accepted with:
- `SERVICE_WINDOW_ONLY`
- `TEMPLATE_REVIEW`
- `TEMPLATE_AUTOPILOT`

Do not start WhatsApp features before the shared core/AI/delivery/handoff dependencies each task requires are stable.

## Phase 5 gate — SaaS UX

Phase 5 contracts are prepared under `docs/tasks/P5-*`, Issues #27–#35, with #36 independent review.

Phase 5 may start **incrementally** when a feature's backend dependency is stable. It does not need to wait for every WhatsApp feature. Examples:
- P5-01 app shell/onboarding after Phase 1 auth/workspace is stable;
- P5-02 Inbox after conversation/message query APIs are stable;
- P5-03/P5-04 after policy/delivery/handoff/AI APIs are stable;
- Knowledge/Style/Leads/Analytics after their respective backend APIs exist.

Do not use a future prepared UX task as permission to bypass its explicit start condition.

## Supervisor rule

After every Claude PR:
1. stop before merge;
2. run ChatGPT architecture review against the issue + contract;
3. run the applicable Codex/Astra independent review contract;
4. fix blocking findings on the same feature branch;
5. merge only after acceptance;
6. update this queue/current handoff if project state materially changes.
