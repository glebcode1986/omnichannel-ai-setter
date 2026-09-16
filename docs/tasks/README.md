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
| R1 | #7 | Codex/Astra | `R1_CODEX_ASTRA_REVIEW_CONTRACT.md` | incremental Phase 1 review |

## Phase 2 execution order — Instagram + shared AI

Starts only after Phase 1 exit criteria.

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

## Agent operating rule

Claude executes one contract/issue at a time on its specified branch and does not opportunistically implement the next contract. Codex/Astra independently reviews/tests by default and reads specs before diffs. ChatGPT maintains product architecture, task contracts, durable memory and architecture review.

## Instagram after-window choice — Accepted

Both `STANDARD_ONLY` and `HUMAN_ASSISTED_EXTENDED` are supported. See ADR-014. Extended mode is an explicit real-human review/send path under currently permitted Human Agent eligibility, not an unattended AI worker pretending to be human.

## WhatsApp after-window choice — Still open

ADR-016 is **Proposed**, not Accepted. Architecture can support both `SERVICE_WINDOW_ONLY` and `TEMPLATE_ASSISTED`, but the product owner has not yet selected the default or whether eligible outside-window templates may auto-send vs require human approval. Coding agents must not invent this decision.
