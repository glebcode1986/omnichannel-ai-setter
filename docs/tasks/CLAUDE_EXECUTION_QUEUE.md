# Claude Execution Queue

> Stable handoff page for the human programmer supervising Claude. Always read this file together with the linked task contract and GitHub issue. Chat history is not the execution source of truth.

## Material state — 2026-09-24

The sections below are the original launch plan and are kept as written. Where the stack actually stands:

Phase 1 and Phase 2 are implemented as one stacked chain of unmerged PRs, `#26 -> ... -> #51 -> #52 -> #63
-> #64 -> #65 -> #66 -> #67 -> #68 -> #69 -> #70 -> #71 -> #72`, each branch based on its parent and each
awaiting independent review in dependency order. Nothing is merged to `main`.

The earliest unresolved review gate is **PR #69 / P2-07**, where independent review found that the review
queue scheduled a delivery without the authority the person had just granted, so every reviewed reply was
executed as automation. The authority is now persisted with the delivery and read from there; see
`docs/specs/HUMAN_HANDOFF.md`. #68 / P2-06 was accepted at `fb35665` and propagated.

Previously the earliest gate was **PR #68 / P2-06**, where independent review found that the send
claim was conditional only on the delivery row and not on the state the pre-send revalidation was made
against. That is corrected on #68: the claim now re-asserts the judged facts in the same statement, and a
claim overtaken by a newer inbound, a takeover, a policy edit or a draft rewrite is refused rather than
sent. `docs/specs/DELIVERY_COORDINATOR.md` records the rule.

#69–#72 stay unchanged until the corrected #68 head is independently accepted; only the accepted
correction is then propagated downstream with ordinary merges.

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
