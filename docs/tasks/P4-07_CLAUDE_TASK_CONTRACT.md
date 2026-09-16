# Task Contract — P4-07 Claude

**Issue:** #24 `[P4-07] Complete WhatsApp AI vertical slice end to end`  
**Branch:** `feat/p4-07-whatsapp-ai-vertical-slice`  
**Owner:** Claude. Do not merge own PR.

## Start condition
#18–#23 accepted and shared AI/retrieval/policy/delivery/handoff core stable. ADR-016 must be accepted before any outside-window auto-template behavior is included.

## Read first
`PROJECT_CONTEXT.md`, `CURRENT_HANDOFF.md`, all WhatsApp specs/ADRs/research, shared AI/policy/delivery/handoff specs, Issue #24.

## Objective
Wire one production-shaped WhatsApp conversation path through the shared omnichannel core without provider-specific shortcuts.

## Required scenarios
- inbound text -> debounce -> retrieval -> AI draft -> deterministic policy -> durable natural delay -> optional presence -> final revalidation -> Cloud API send -> status reconciliation;
- DRAFT review/approval and AUTOPILOT in open service window;
- outside-window behavior according to accepted ADR-016;
- newer inbound supersedes pending send;
- native/manual human activity pauses AI where current Meta signals allow detection;
- own API events do not falsely trigger takeover;
- voice note -> media fetch -> transcription -> AI/review;
- media/transcription failure -> review;
- low confidence/missing fact -> review;
- definite rejection vs ambiguous network outcome;
- duplicate webhook/job/reordered status cannot double-send.

## Integration
Automated tests use fixture/fake Meta/provider. Add a documented sandbox/manual test plan for an authorized Meta test/professional WhatsApp account.

## Guard
No route/UI/worker bypasses shared deterministic policy, handoff or delivery coordinator. Do not add unofficial transport.

## PR
Include end-to-end sequence diagram, scenarios and exact commands. R4 review required before merge.