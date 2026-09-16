# Current Handoff

**Date:** 2026-09-16  
**Phase:** 0 — Architecture / specification  
**Repository:** `glebcode1986/omnichannel-ai-setter`

## Completed

- Dedicated private GitHub repository created and connected.
- Canonical project/scaffold documentation committed.
- Product direction: multi-channel AI setter, Instagram + WhatsApp first.
- Official WhatsApp Cloud API only for production.
- Channel-neutral core, durable debounce/delay, final pre-send revalidation and human takeover are accepted decisions.
- Open-source WhatsApp research identified `wacrm` as the strongest official-API implementation reference; Senqo is useful for agent/inbox/eval ideas but not transport.

## Immediate next work

1. Verify current Meta Instagram and WhatsApp API constraints from official documentation.
2. Deep-review `wacrm` webhook/send/template/AI-handoff code paths and license before any reuse.
3. Freeze monorepo layout, ORM, queue and auth/workspace decisions via ADRs.
4. Freeze `ChannelAdapter`, normalized event and send result contracts.
5. Create Phase 1 GitHub issues for Claude with acceptance criteria and explicit ownership.
6. Use Codex/Astra as independent reviewer/test author rather than simultaneous editor of the same module.

## Next-session instruction

Read `PROJECT_CONTEXT.md` and this file first. Do not rely on old chat history. Continue from open GitHub issues and current ADR/spec status.
