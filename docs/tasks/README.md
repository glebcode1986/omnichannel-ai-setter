# Execution Task Contracts

This directory contains durable, executable instructions for coding/review agents. Chat history is not an implementation contract.

Supervisor shortcut: use [`CLAUDE_EXECUTION_QUEUE.md`](./CLAUDE_EXECUTION_QUEUE.md) to see the current/next Claude task and launch condition.

## Phase 1 execution order

| Step | Issue | Executor | Contract | Start condition |
|---|---:|---|---|---|
| P1-01 | #2 | Claude | `P1-01_CLAUDE_TASK_CONTRACT.md` | running now |
| P1-02 | #3 | Claude | `P1-02_CLAUDE_TASK_CONTRACT.md` | #2 accepted/merged |
| P1-03 | #4 | Claude | `P1-03_CLAUDE_TASK_CONTRACT.md` | #2/#3 accepted; may run alongside P1-04 |
| P1-04 | #5 | Claude | `P1-04_CLAUDE_TASK_CONTRACT.md` | #2/#3 accepted; shared IDs stable |
| P1-05 | #6 | Claude | `P1-05_CLAUDE_TASK_CONTRACT.md` | #3/#4/#5 accepted |
| R1 | #7 | Codex/Astra | `R1_CODEX_ASTRA_REVIEW_CONTRACT.md` | incremental Phase 1 review |

## Phase 2 execution order — Instagram + shared AI

Starts only after Phase 1 exit criteria unless the architecture plan is explicitly amended.

| Step | Issue | Executor | Contract |
|---|---:|---|---|
| P2-01 | #8 | Claude | `P2-01_CLAUDE_TASK_CONTRACT.md` |
| P2-02 | #9 | Claude | `P2-02_CLAUDE_TASK_CONTRACT.md` |
| P2-03 | #10 | Claude | `P2-03_CLAUDE_TASK_CONTRACT.md` |
| P2-04 | #11 | Claude | `P2-04_CLAUDE_TASK_CONTRACT.md` |
| P2-05 | #12 | Claude | `P2-05_CLAUDE_TASK_CONTRACT.md` |
| P2-06 | #13 | Claude | `P2-06_CLAUDE_TASK_CONTRACT.md` |
| P2-07 | #14 | Claude | `P2-07_CLAUDE_TASK_CONTRACT.md` |
| P2-08 | #15 | Claude + independent adversarial additions | `P2-08_CLAUDE_TASK_CONTRACT.md` |
| P2-09 | #16 | Claude | `P2-09_CLAUDE_TASK_CONTRACT.md` |
| R2 | #17 | Codex/Astra | `R2_CODEX_ASTRA_REVIEW_CONTRACT.md` |

## Phase 4 execution order — WhatsApp Cloud API

Implementation reuses the stable shared AI/policy/delivery/handoff core. See `docs/specs/PHASE4_WHATSAPP_IMPLEMENTATION_PLAN.md`.

| Step | Issue | Executor | Contract |
|---|---:|---|---|
| P4-01 | #18 | Claude | `P4-01_CLAUDE_TASK_CONTRACT.md` |
| P4-02 | #19 | Claude | `P4-02_CLAUDE_TASK_CONTRACT.md` |
| P4-03 | #20 | Claude | `P4-03_CLAUDE_TASK_CONTRACT.md` |
| P4-04 | #21 | Claude | `P4-04_CLAUDE_TASK_CONTRACT.md` |
| P4-05 | #22 | Claude | `P4-05_CLAUDE_TASK_CONTRACT.md` |
| P4-06 | #23 | Claude | `P4-06_CLAUDE_TASK_CONTRACT.md` |
| P4-07 | #24 | Claude | `P4-07_CLAUDE_TASK_CONTRACT.md` |
| R4 | #25 | Codex/Astra | `R4_CODEX_ASTRA_REVIEW_CONTRACT.md` |

## Phase 5 execution order — SaaS product UX

Phase 5 can start incrementally once each feature's backend dependencies are stable; it does not require every WhatsApp feature to be finished first.

| Step | Issue | Executor | Contract |
|---|---:|---|---|
| P5-01 | #27 | Claude | `P5-01_CLAUDE_TASK_CONTRACT.md` |
| P5-02 | #28 | Claude | `P5-02_CLAUDE_TASK_CONTRACT.md` |
| P5-03 | #29 | Claude | `P5-03_CLAUDE_TASK_CONTRACT.md` |
| P5-04 | #30 | Claude | `P5-04_CLAUDE_TASK_CONTRACT.md` |
| P5-05 | #31 | Claude | `P5-05_CLAUDE_TASK_CONTRACT.md` |
| P5-06 | #32 | Claude | `P5-06_CLAUDE_TASK_CONTRACT.md` |
| P5-07 | #33 | Claude | `P5-07_CLAUDE_TASK_CONTRACT.md` |
| P5-08 | #34 | Claude | `P5-08_CLAUDE_TASK_CONTRACT.md` |
| P5-09 | #35 | Claude | `P5-09_CLAUDE_TASK_CONTRACT.md` |
| R5 | #36 | Codex/Astra | `R5_CODEX_ASTRA_REVIEW_CONTRACT.md` |

## Agent operating rule

Claude executes one contract/issue at a time on its specified branch and does not opportunistically implement the next contract. Codex/Astra independently reviews/tests by default and reads specs before diffs. ChatGPT maintains product architecture, task contracts, durable memory and architecture review.

## Instagram after-window choice — Accepted

Both `STANDARD_ONLY` and `HUMAN_ASSISTED_EXTENDED` are supported. See ADR-014. Extended mode is an explicit real-human review/send path under currently permitted Human Agent eligibility, not an unattended AI worker pretending to be human.

## WhatsApp after-window choice — Accepted

ADR-016 supports all three account/workspace-selectable modes:

- `SERVICE_WINDOW_ONLY`
- `TEMPLATE_REVIEW`
- `TEMPLATE_AUTOPILOT`

No stored choice means `SERVICE_WINDOW_ONLY` until configured. `TEMPLATE_AUTOPILOT` requires an explicit automation allowlist; an empty allowlist sends nothing unattended. Current provider consent/template/account-health/STOP rules and final pre-send revalidation always win.
