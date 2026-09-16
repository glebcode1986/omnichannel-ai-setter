# Project Context — Canonical Memory

> Durable project memory. A new AI session must read this file first, then `docs/handoff/CURRENT_HANDOFF.md`, then relevant specs/issues. Chat history is not the source of truth.

## Goal

Build a commercial SaaS product that handles inbound conversations across Instagram and WhatsApp in the owner's voice, answers from business knowledge, qualifies leads, follows platform policy, escalates uncertain/sensitive cases and hands control to a human cleanly.

## Product direction

One shared conversation/AI core with channel adapters. MVP channels: Instagram Messaging API and official WhatsApp Business Cloud API. Threads remains a future channel because no supported public Threads DM API was identified in the 2026-09-16 Meta verification.

## Verified platform constraints (2026-09-16)

- Instagram MVP uses professional accounts via Instagram API with Instagram Login and `instagram_business_manage_messages`.
- Instagram official messaging is inbound-first: the customer/user must initiate the conversation before the app can reply.
- Meta's current Instagram API surface includes a `HUMAN_AGENT` send capability for approved human support outside the standard automated window; current eligibility/approval rules must be re-verified at implementation/App Review time.
- WhatsApp free-form business replies are governed by the current 24-hour customer-service window; approved templates are required outside it where Meta policy requires.
- Platform policy is adapter/policy-layer logic, never prompt-only logic.

See `docs/research/META_API_VERIFICATION.md` and `docs/research/META_INSTAGRAM_PHASE2_VERIFICATION.md`.

## Instagram after-window product choice

The owner explicitly chose a configurable behavior rather than one hard-coded policy:

- `STANDARD_ONLY`: after the standard automated window closes, AI does not send until the user reopens the conversation.
- `HUMAN_ASSISTED_EXTENDED`: AI may prepare an after-window draft; when current Meta Human Agent eligibility/approval exists, a real human may review/edit/approve and initiate the tagged send.

The automated worker must not silently attach `HUMAN_AGENT` merely to impersonate a human. The human-assisted option exists as a deliberate human-in-the-loop product mode. See ADR-014.

## Open-source references

- **OpenSetter** (`xbirimensah/opensetter`, reviewed at commit `aa7d97c38b6d6698df1202d87c00fef5c983cfcb`, MIT) — primary AI-setter conceptual/implementation reference. Current stack includes Prisma 7, BullMQ 5, ioredis, Next.js 16, NextAuth, Zod and Vitest.
- **wacrm** (`ArnasDon/wacrm`, reviewed at commit `80c3f9a1aecdaf21b98311f230fdaaaec7d85f7d`, MIT) — strong official WhatsApp Cloud API reference for webhook/send/template/media/signature/inbox/CRM/AI patterns and tests.
- **InstaAuto** — inbox/automation UX patterns; license/commit must be verified before code reuse.
- **Claude Instagram Bot** — qualification/playbook/voice/handoff ideas; license/commit must be verified before code reuse.
- **Senqo** — agent/shared-inbox/CRM/handoff/evaluation ideas; do not use its Baileys/QR transport in production.

All source reuse requires file-level attribution in `THIRD_PARTY.md`.

## Accepted architecture

- Channel-neutral domain/application core.
- `ChannelAdapter` boundary for Instagram/WhatsApp.
- Official WhatsApp Cloud API only.
- Instagram API with Instagram Login preferred for MVP.
- Threads DM not MVP.
- TypeScript + Next.js 16/React 19 surface.
- PostgreSQL via Prisma 7.
- BullMQ 5 + Redis/ioredis for durable async work/delay scheduling.
- Auth.js + Prisma WorkspaceMember tenancy.
- Webhooks validate/normalize/persist/enqueue and return quickly.
- AI generation and outbound delivery are separate stages.
- Provider-neutral AI contract with schema-validated structured output.
- Factual knowledge and style memory are separate retrieval domains using PostgreSQL hybrid retrieval (lexical + pgvector behind infrastructure boundaries).
- Deterministic policy engine, not the LLM alone, decides send/review eligibility.
- One delivery coordinator owns natural delay, final revalidation, atomic claim and send-result handling.
- Human activity pauses/cancels automation; unmatched outbound echo is a takeover signal.
- Ambiguous transport outcomes are quarantined, never blindly retried.

## Human-like timing

Initial configurable targets: inbound burst debounce 7–12 seconds; post-draft delivery delay 30–120 seconds. Phase 2 natural profile uses a non-uniform distribution centered near ~60 seconds. Final gate checks newer inbound, human takeover, current mode, service/policy window, draft freshness, account health and idempotency.

## Modes

- `OFF`: mirror only, no AI drafts.
- `DRAFT`: generate and hold for review.
- `AUTOPILOT`: auto-send only when deterministic gates pass.

After-window policy is separate from AiMode; do not overload these enums.

## Human takeover

Verified manual human reply always wins. Automation pauses for a configurable period or until resumed. Own API echoes must not be mistaken for human sends. Human Agent review is `REVIEW_REQUIRED` until a real human acts.

## AI contract

Structured output includes `reply`, `confidence`, `should_send`, `needs_review`, `reason_codes[]`, `intent`, `lead_stage`, optional `suggested_action`, and factual source IDs when relevant. Knowledge and style are separate retrieval domains; style never establishes business facts. Model `should_send` is advisory only.

## Current execution state

Phase 0 is complete. Phase 1 implementation issues #2–#6 are still the required coding entry point, with #7 independent review. Phase 2 architecture/specification is prepared and implementation issues #8–#16 plus #17 independent review are open but blocked until Phase 1 exit criteria are satisfied.

## Development workflow

- ChatGPT: product/architecture lead, specs, issue decomposition, review, repository memory.
- Claude: primary implementation agent working from GitHub issues/specs.
- Codex/Astra: independent tests, migrations, adapters, static/security review, refactors and verification. Avoid concurrent editing of the same module.

## Continuity rule

Every material decision, task, completed milestone and unresolved question must be committed into this repository. New sessions should continue from GitHub alone.
