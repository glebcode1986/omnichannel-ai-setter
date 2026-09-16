# Current Handoff

**Date:** 2026-09-16  
**Phase:** Phase 0 complete; Phase 1 ready to start  
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
- Issue #1 upstream extraction map is completed and closed.
- Implementation backlog is open as issues #2–#6 for Claude and #7 for independent Codex/Astra review.

## Open issues / execution order

1. #2 — scaffold pnpm workspace/tooling (Claude).
2. #3 — domain + channel contracts (Claude).
3. #4 and #5 — DB/auth and queue/delay can proceed in parallel after #3 stabilizes.
4. #6 — webhook ingestion after #3/#4/#5.
5. #7 — Codex/Astra independently reviews/test-adds throughout Phase 1.

## Coding rule for next session

Do not restart architecture from chat memory. Read `PROJECT_CONTEXT.md`, this file, ADRs/specs, `UPSTREAM_EXTRACTION_MAP.md`, `IMPLEMENTATION_PLAN.md` and open GitHub issues. Claude starts with issue #2. Codex/Astra is a reviewer/test author unless explicitly assigned an independent feature module.

## Immediate next action

Give Claude issue #2 (`[P1-01] Scaffold pnpm workspace and baseline tooling`) as its first implementation task. After its PR exists, review it against #2 acceptance criteria and then run the independent #7 review track before or alongside merge.

## Architecture work that may proceed in parallel

Prepare Phase 2 issue decomposition without editing Claude-owned Phase 1 packages: Instagram adapter/onboarding, AI model/provider interface, factual/style retrieval, deterministic policy engine, delivery coordinator and human-handoff state machine.
