# Claude Execution Queue

> Stable handoff page for the human programmer supervising Claude. Always read this file together with the linked task contract and GitHub issue. Chat history is not the execution source of truth.

## Material state — 2026-09-29

**This section is the live instruction. Everything under "Historical launch plan" below is kept for the
record and is not a current task.**

Phase 1 and Phase 2 are implemented as one stacked chain of unmerged PRs, each branch based on its parent
and each awaiting independent review in dependency order:

`#26 -> #49 -> #50 -> #51 -> #52 -> #63 -> #64 -> #65 -> #66 -> #67 -> #68 -> #69 -> #70 -> #71 -> #72`

Nothing is merged to `main`.

### Current gate — PR #71 / P2-09 (Issue #16)

**PR [#71](https://github.com/glebcode1986/omnichannel-ai-setter/pull/71) is the earliest unresolved gate.**
Branch `feat/p2-09-instagram-slice`, carrying the Instagram vertical slice, with the accepted #70 head
merged down into it.

The review at `d77cf92b4b7e860adfe2dfb1a47b33dc9d6babe0` named two composition blockers, and both are now
addressed on the branch: `apps/web` registers an Instagram adapter per resolved channel account, reading
that account's own credential through its relation and binding none at all when the webhook verify token
is unconfigured; and the live `INSTAGRAM_HUMAN_AGENT_APPROVAL` reaches the draft disposition, the final
channel-state resolver and the sender from one place, so an approved human-support reply is reachable
through the shared gate instead of being refused before the transport is consulted.

### Accepted and propagated

- **PR #70 / P2-08 (Issue #15)** was independently accepted at
  `c15a9a6f558d9270263ad7573669f76ca3af8ac0`. The evaluation harness now asserts the model's own intent and
  suggested lead stage rather than merely supplying them, so a classification regression can no longer hide
  behind an identical reply — see `docs/specs/AI_EVALUATION.md`.
- **PR #69 / P2-07 (Issue #14)** was independently accepted at
  `4c9f496d805316ded56311e41bdd4c3c39ff5a43`. The authority a reviewed reply is sent under is persisted with
  the delivery and read from there; the approver is the authenticated member rather than one the command
  named; each decision commits in one transaction; and an existing send is reused only for a provably
  identical decision. See `docs/specs/HUMAN_HANDOFF.md`.
- **PR #68 / P2-06 (Issue #13)** was independently accepted at `fb35665209b90c82bc10f3068450111e75f83299`.
  The send claim re-asserts the state its revalidation was made against, inside a transaction that shares
  row locks with the writers of those facts — see `docs/specs/DELIVERY_COORDINATOR.md`.
- Everything earlier in the chain up to and including **#67 / P2-05** has an independent PASS at its
  published head.

### Blocked

**#72 stays unchanged until #71 has an independent PASS at its exact head.** After it, only the
accepted correction is propagated downstream with ordinary merges, each branch verified before pushing. Do
not rebase, force-push, merge to `main`, or start Stage D.

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

---

# Historical launch plan

> Kept for the record. **None of the sections below is a current task.** They describe the original Phase 1
> launch sequence, which has been carried out: every task named here is implemented and sits in the stacked
> chain above. Read the "Material state" section for what to work on.

## First task — HISTORICAL

### P1-01 — Issue #2: Scaffold pnpm workspace and baseline tooling

Contract: [`P1-01_CLAUDE_TASK_CONTRACT.md`](./P1-01_CLAUDE_TASK_CONTRACT.md)

Branch: `feat/p1-01-project-skeleton` — implemented, PR #26, awaiting independent review in chain order.

## Second task — HISTORICAL

### P1-02 — Issue #3: Domain model and channel contracts

Contract: [`P1-02_CLAUDE_TASK_CONTRACT.md`](./P1-02_CLAUDE_TASK_CONTRACT.md)

Branch: `feat/p1-02-domain-channel-contracts` — implemented, PR #49.

## Queue after P1-02 — HISTORICAL

1. P1-03 / #4 — Prisma + Auth.js + workspace isolation (`P1-03_CLAUDE_TASK_CONTRACT.md`) — PR #50.
2. P1-04 / #5 — BullMQ durable queue/delay primitives (`P1-04_CLAUDE_TASK_CONTRACT.md`) — PR #51.
3. P1-05 / #6 — channel-neutral webhook ingestion (`P1-05_CLAUDE_TASK_CONTRACT.md`) — PR #52.
4. R1 / #7 — independent Codex/Astra review throughout Phase 1 — ongoing, per PR.

## Phase 2 gate — Instagram + shared AI — HISTORICAL

Phase 2 was started under the owner's Stage B directive (MASTER Issue #61) once the Issue #53 Business
Profile sync completed, and is implemented as PRs #63–#71 in the chain above. Contracts: `docs/tasks/P2-*`.

