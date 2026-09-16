# Task Contract — P4-01 Claude

**Issue:** #18 `[P4-01] Implement WhatsApp Cloud API transport adapter`  
**Branch:** `feat/p4-01-whatsapp-adapter`  
**Owner:** Claude. Do not merge own PR.

## Start condition
Shared Phase 1 channel/ingestion contracts and delivery semantics are accepted/stable.

## Read first
`PROJECT_CONTEXT.md`, `CURRENT_HANDOFF.md`, `AGENTS.md`, `CLAUDE.md`, `WHATSAPP_ADAPTER.md`, `CHANNEL_CONTRACTS.md`, ADR-002/012/013, `META_WHATSAPP_PHASE4_VERIFICATION.md`, Issue #18.

## Objective
Implement `packages/channel-whatsapp` against the shared `ChannelAdapter` using official Cloud API only.

## Required scope
- raw-body webhook verification, fail closed;
- deterministic normalization of inbound text/media/audio/document/image/video, reply context and statuses;
- trusted WABA/phone-number asset -> `ChannelAccount` resolution;
- status reconciliation data with provider timestamps;
- free-form text send -> `ACCEPTED | REJECTED | AMBIGUOUS`;
- normalized window evaluation including `OPEN_FREEFORM` and `TEMPLATE_ONLY`;
- best-effort read/typing transport capability surface;
- unknown payloads auditable and safe.

## Forbidden
No LLM/retrieval, business reply selection, human-like delay, template automation policy, unofficial WhatsApp Web/Baileys/session transport, or provider types leaking to core.

## Tests
Signature success/failure, duplicate inbound, text/audio/media, reply context, reordered statuses, accepted/rejected/ambiguous send, free-form open/template-only, malformed/unknown payload.

## PR
Re-verify current Meta API fields/version/signature rules. Run package + root checks. Do not merge.