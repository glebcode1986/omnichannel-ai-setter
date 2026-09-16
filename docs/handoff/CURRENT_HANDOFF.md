# Current Handoff

**Date:** 2026-09-16  
**Phase:** 0 — Architecture / specification  
**Repository:** `glebcode1986/omnichannel-ai-setter`

## Completed

- Dedicated private GitHub repository created and project-memory scaffold committed.
- Product is a multi-channel AI setter, Instagram + WhatsApp first.
- Core is channel-neutral; human-like delays are durable jobs; final revalidation and human takeover are mandatory.
- Production WhatsApp uses official Meta Cloud API only.
- Current Meta constraints verified: Instagram professional-account messaging is inbound-first; WhatsApp uses a 24-hour customer-service window for free-form replies; Threads has no verified public DM API and is excluded from MVP.
- OpenSetter reviewed at `aa7d97c38b6d6698df1202d87c00fef5c983cfcb` (MIT). Its Prisma 7 + BullMQ 5 + Redis stack aligns with our needs.
- wacrm reviewed at `80c3f9a1aecdaf21b98311f230fdaaaec7d85f7d` (MIT) as our strongest WhatsApp implementation reference.
- ADR accepted for Prisma/PostgreSQL + BullMQ/Redis and Instagram Login path.

## Immediate next work

1. Create extraction map: exact OpenSetter/wacrm files to adapt vs independently reimplement.
2. Decide monorepo/package layout.
3. Decide auth/workspace model.
4. Freeze `ChannelAdapter`, normalized event and `SendResult` contracts.
5. Create Phase 1 implementation issues for Claude.
6. Assign Codex/Astra independent verification/testing tasks rather than concurrent edits to Claude-owned modules.

## Next-session instruction

Read `PROJECT_CONTEXT.md`, this file, open ADRs and GitHub issues. Continue from repository state rather than old chat transcripts.
