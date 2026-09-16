# Current Handoff

**Date:** 2026-09-16  
**Phase:** 0 — Architecture / specification  
**Repository:** `glebcode1986/omnichannel-ai-setter`

## Completed

- Dedicated private GitHub repository and durable project-memory docs.
- Instagram + WhatsApp product direction; Threads DM explicitly future-only until official API exists.
- Official Meta constraints verified and documented.
- Channel-neutral core; durable debounce/delay; final pre-send revalidation; human takeover.
- OpenSetter anchor `aa7d97c38b6d6698df1202d87c00fef5c983cfcb` MIT; wacrm anchor `80c3f9a1aecdaf21b98311f230fdaaaec7d85f7d` MIT.
- Accepted core stack: Next.js/TypeScript, Prisma/PostgreSQL, BullMQ/Redis, Vitest/Zod.
- Accepted pnpm workspace layout with separate `apps/web` and `apps/worker` plus bounded packages.
- Accepted Auth.js + Prisma workspace membership model for MVP.
- Initial `ChannelAdapter`, normalized event, window-decision and send-result contracts frozen in `docs/specs/CHANNEL_CONTRACTS.md`.

## Immediate next work

1. Create exact OpenSetter/wacrm extraction map: files/concepts to adapt vs reimplement.
2. Create Phase 1 GitHub issues with dependencies, package ownership and acceptance criteria.
3. Claude begins only with P1-01 after Phase-0 backlog is committed.
4. Codex/Astra receives independent test/review tickets; avoid simultaneous edits to Claude-owned packages.

## New-session instruction

Read `PROJECT_CONTEXT.md`, this file, open ADRs/specs and GitHub issues. Continue from repository state, not old chat history.
