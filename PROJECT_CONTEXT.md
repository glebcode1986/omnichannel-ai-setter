# Project Context — Canonical Memory

> Durable project memory. A new AI session must read this file first, then `docs/handoff/CURRENT_HANDOFF.md`, then relevant specs/issues. Chat history is not the source of truth.

## Goal

Build a commercial SaaS product that handles inbound conversations across Instagram and WhatsApp in the owner's voice, answers from business knowledge, qualifies leads, follows platform policy, escalates uncertain/sensitive cases and hands control to a human cleanly.

## Product direction

One shared conversation/AI core with channel adapters. MVP channels: Instagram Messaging API and official WhatsApp Business Cloud API. Threads remains a future channel because no supported public Threads DM API was identified in the 2026-09-16 Meta verification.

## Verified platform constraints (2026-09-16)

- Instagram MVP uses professional accounts via Instagram API with Instagram Login and `instagram_business_manage_messages`.
- Instagram official messaging is inbound-first: the customer/user must initiate the conversation before the app can reply.
- WhatsApp free-form business replies are governed by the current 24-hour customer-service window; approved templates are required outside it where Meta policy requires.
- Platform policy is adapter/policy-layer logic, never prompt-only logic.

See `docs/research/META_API_VERIFICATION.md`.

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
- Webhooks validate/normalize/persist/enqueue and return quickly.
- AI generation and outbound delivery are separate stages.
- Final pre-send revalidation is mandatory.
- Human activity pauses/cancels automation.
- Deterministic policy engine, not the LLM alone, decides auto-send eligibility.

## Human-like timing

Initial configurable targets: inbound burst debounce 7–12 seconds; post-draft delivery delay 30–120 seconds. Final gate checks newer inbound, human takeover, current mode, service/policy window, draft freshness, account health and idempotency.

## Modes

- `OFF`: mirror only, no AI drafts.
- `DRAFT`: generate and hold for review.
- `AUTOPILOT`: auto-send only when deterministic gates pass.

## Human takeover

Verified manual human reply always wins. Automation pauses for a configurable period or until resumed. Own API echoes must not be mistaken for human sends.

## AI contract

Structured output includes `reply`, `confidence`, `should_send`, `needs_review`, `reason_codes[]`, `intent`, `lead_stage`, optional `suggested_action`. Knowledge and style are separate retrieval domains; style never establishes business facts.

## Development workflow

- ChatGPT: product/architecture lead, specs, issue decomposition, review, repository memory.
- Claude: primary implementation agent working from GitHub issues/specs.
- Codex/Astra: independent tests, migrations, adapters, static/security review, refactors and verification. Avoid concurrent editing of the same module.

## Continuity rule

Every material decision, task, completed milestone and unresolved question must be committed into this repository. New sessions should continue from GitHub alone.
