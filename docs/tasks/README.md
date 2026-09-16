# Execution Task Contracts

This directory contains durable, executable instructions for coding/review agents. Chat history is not an implementation contract.

## Phase 1 execution order

| Step | Issue | Executor | Contract | Start condition |
|---|---:|---|---|---|
| P1-01 | #2 | Claude | `P1-01_CLAUDE_TASK_CONTRACT.md` | start now |
| P1-02 | #3 | Claude | `P1-02_CLAUDE_TASK_CONTRACT.md` | #2 accepted/merged |
| P1-03 | #4 | Claude | `P1-03_CLAUDE_TASK_CONTRACT.md` | #2/#3 accepted; may run alongside P1-04 |
| P1-04 | #5 | Claude | `P1-04_CLAUDE_TASK_CONTRACT.md` | #2/#3 accepted; shared IDs stable |
| P1-05 | #6 | Claude | `P1-05_CLAUDE_TASK_CONTRACT.md` | #3/#4/#5 accepted |
| R1 | #7 | Codex/Astra | `R1_CODEX_ASTRA_REVIEW_CONTRACT.md` | run incrementally on reviewable Phase 1 PRs |

## Phase 2 execution order

Phase 2 implementation starts only after Phase 1 exit criteria are met.

| Step | Issue | Executor | Contract | Primary dependency |
|---|---:|---|---|---|
| P2-01 | #8 | Claude | `P2-01_CLAUDE_TASK_CONTRACT.md` | Phase 1 exit |
| P2-02 | #9 | Claude | `P2-02_CLAUDE_TASK_CONTRACT.md` | Phase 1 exit / coordinate with P2-01 |
| P2-03 | #10 | Claude | `P2-03_CLAUDE_TASK_CONTRACT.md` | stable core/application |
| P2-04 | #11 | Claude | `P2-04_CLAUDE_TASK_CONTRACT.md` | DB + P2-03 request contract |
| P2-05 | #12 | Claude | `P2-05_CLAUDE_TASK_CONTRACT.md` | P2-03 + P2-04 |
| P2-06 | #13 | Claude | `P2-06_CLAUDE_TASK_CONTRACT.md` | queue + P2-01 + P2-05 |
| P2-07 | #14 | Claude | `P2-07_CLAUDE_TASK_CONTRACT.md` | P2-01 + P2-05 + P2-06 |
| P2-08 | #15 | Claude + independent adversarial additions | `P2-08_CLAUDE_TASK_CONTRACT.md` | P2-03–P2-07 stable |
| P2-09 | #16 | Claude | `P2-09_CLAUDE_TASK_CONTRACT.md` | P2-01–P2-08 accepted |
| R2 | #17 | Codex/Astra | `R2_CODEX_ASTRA_REVIEW_CONTRACT.md` | run incrementally; required for final vertical slice |

## Agent operating rule

For Claude: execute one contract/issue at a time on its specified branch. Do not opportunistically implement the next contract.

For Codex/Astra: act as an independent reviewer/test author by default. Read specs/contracts before the implementation diff. Do not edit the same feature module concurrently unless explicitly reassigned.

For ChatGPT: maintain architecture/specs/task contracts and review implementation against them. Any material decision from a conversation must be committed to project documentation before it is treated as durable project state.

## Instagram after-window product choice

The accepted product supports both:

- `STANDARD_ONLY`
- `HUMAN_ASSISTED_EXTENDED`

See ADR-014. `HUMAN_ASSISTED_EXTENDED` means AI drafting plus explicit real-human review/send through a currently permitted/approved Human Agent path; it is not a background worker silently labelling AI output as human activity.
