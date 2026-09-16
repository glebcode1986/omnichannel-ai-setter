# Current Handoff

**Date:** 2026-09-16  
**Phase:** Phase 0 complete; Phase 1 ready to implement; Phase 2 architecture prepared  
**Repository:** `glebcode1986/omnichannel-ai-setter`

## Completed

- Durable project-memory repo and agent instructions.
- Instagram + WhatsApp product direction; Threads DM future-only until official API exists.
- Official Meta constraints verified/documented.
- Channel-neutral core; durable debounce/delay; final pre-send revalidation; human takeover.
- OpenSetter anchor `aa7d97c38b6d6698df1202d87c00fef5c983cfcb` MIT.
- wacrm anchor `80c3f9a1aecdaf21b98311f230fdaaaec7d85f7d` MIT.
- Accepted stack: Next.js/TypeScript, Prisma/PostgreSQL, BullMQ/Redis, Vitest/Zod.
- Accepted pnpm workspace, Auth.js + Prisma workspace membership and initial channel contracts.
- Exact upstream extraction strategy committed to `docs/research/UPSTREAM_EXTRACTION_MAP.md`.
- Phase 1 implementation workflow committed to `docs/specs/IMPLEMENTATION_PLAN.md`.
- Issue #1 upstream extraction map completed and closed.
- Phase 1 backlog open as #2–#6 with #7 independent Codex/Astra review.
- Phase 2 specs added: Instagram adapter, AI orchestration, retrieval, policy engine, delivery coordinator, human handoff, Meta verification.
- ADRs 010–014 added for provider-neutral AI, hybrid retrieval, atomic/ambiguous delivery, echo-based takeover and configurable Instagram after-window policy.
- Product owner explicitly chose two Instagram after-window modes: `STANDARD_ONLY` and `HUMAN_ASSISTED_EXTENDED`.
- Phase 2 backlog open as #8–#16 with #17 independent Codex/Astra review.
- Complete Phase 1 executable task-contract set created under `docs/tasks/` for Claude (#2–#6) and Codex/Astra (#7), with `docs/tasks/README.md` as the execution index.

## Important Instagram after-window rule

Do not revert to the earlier hard-coded 'never use HUMAN_AGENT' idea. The accepted product design is configurable:

- `STANDARD_ONLY`: no send after the standard automated window until the user messages again.
- `HUMAN_ASSISTED_EXTENDED`: AI may draft after the standard window; if current Meta Human Agent eligibility/approval exists, a real human may explicitly review/edit/approve and initiate the tagged send.

The current architecture does **not** authorize a background AI worker to silently attach HUMAN_AGENT as if it were a human. Exact Meta window duration/approval/allowed-use rules must be re-verified before implementation/App Review.

## Open issues / execution order

### Phase 1 — start here

1. #2 — scaffold pnpm workspace/tooling (Claude). Contract: `docs/tasks/P1-01_CLAUDE_TASK_CONTRACT.md`.
2. #3 — domain + channel contracts (Claude). Contract: `docs/tasks/P1-02_CLAUDE_TASK_CONTRACT.md`.
3. #4 — Prisma/Auth.js/workspace isolation (Claude). Contract: `docs/tasks/P1-03_CLAUDE_TASK_CONTRACT.md`.
4. #5 — BullMQ durable queues/delay primitives (Claude). Contract: `docs/tasks/P1-04_CLAUDE_TASK_CONTRACT.md`. #4 and #5 may proceed in parallel only after #3/shared IDs stabilize and on separate modules/branches.
5. #6 — webhook ingestion after #3/#4/#5 (Claude). Contract: `docs/tasks/P1-05_CLAUDE_TASK_CONTRACT.md`.
6. #7 — independent Codex/Astra review throughout Phase 1. Contract: `docs/tasks/R1_CODEX_ASTRA_REVIEW_CONTRACT.md`.

### Phase 2 — prepared but blocked until Phase 1 exit

- #8 Instagram transport adapter/fixtures.
- #9 Instagram Login onboarding/token lifecycle.
- #10 provider-neutral AI draft engine.
- #11 factual/style retrieval.
- #12 deterministic policy engine.
- #13 delivery coordinator/final revalidation.
- #14 human handoff/review state machine.
- #15 evaluation harness/golden conversations.
- #16 end-to-end Instagram AI vertical slice.
- #17 independent Codex/Astra Phase 2 review.

See `docs/specs/PHASE2_IMPLEMENTATION_PLAN.md`.

## Coding rule for next session

Do not restart architecture from chat memory. Read `PROJECT_CONTEXT.md`, this file, `docs/tasks/README.md`, ADRs/specs, `UPSTREAM_EXTRACTION_MAP.md`, Phase 1/Phase 2 implementation plans and open GitHub issues.

Claude still starts with Issue #2. Do not jump to #8 merely because Phase 2 is documented; #8–#16 remain blocked by Phase 1 exit criteria.

Codex/Astra is a reviewer/test author unless explicitly assigned a bounded independent module.

## Immediate next action

Run `docs/tasks/P1-01_CLAUDE_TASK_CONTRACT.md` in Claude Code. Claude should create branch `feat/p1-01-project-skeleton`, implement only Issue #2, run required checks and open a PR without merging. Then perform ChatGPT architecture review and the #7 independent Codex/Astra review against that PR before/alongside merge.
