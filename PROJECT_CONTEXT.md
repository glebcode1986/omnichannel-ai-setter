# Project Context — Canonical Memory

> Durable project memory. A new AI session must read this file first, then `docs/handoff/CURRENT_HANDOFF.md`, then relevant specs/issues. Chat history is not the source of truth.

## Goal

Build a commercial SaaS product that handles inbound conversations across Instagram and WhatsApp in the owner's voice, answers from business knowledge, qualifies leads, follows platform policy, escalates uncertain/sensitive cases and hands control to a human cleanly.

## Product direction

One shared conversation/AI core with channel adapters. MVP channels: Instagram Messaging API and official WhatsApp Business Cloud API. Threads is not an MVP private-messaging channel unless Meta exposes a supported public DM API in the future.

## Open-source references

- **OpenSetter** — conceptual reference for AI setter orchestration, modes, confidence/safety gates, knowledge/style memory, debounce, human takeover and queue/reconciliation patterns.
- **InstaAuto** — inbox and automation UX patterns.
- **Claude Instagram Bot** — lead qualification, playbook/rate-card, voice transcription, structured handoff and owner alerts.
- **wacrm** — strong official WhatsApp Cloud API reference: webhook/send/template/media/policy/inbox/CRM/AI patterns and tests.
- **Senqo** — useful AI-agent/shared-inbox/CRM/handoff/evaluation ideas, but its Baileys/QR WhatsApp transport is not acceptable for production.

All code reuse requires license/commit/file attribution review in `THIRD_PARTY.md` before copying.

## Accepted architectural decisions

- Channel-neutral domain and application core.
- `ChannelAdapter` boundary for Instagram/WhatsApp.
- Official WhatsApp Cloud API only in production.
- Durable queue for debounce/delayed delivery/retries; never `sleep` in webhook handlers.
- Webhooks validate/normalize/persist/enqueue and return quickly.
- AI generation and outbound delivery are separate stages.
- Final pre-send revalidation is mandatory.
- Human activity pauses/cancels automation.
- The deterministic policy engine, not the LLM alone, decides whether auto-send is allowed.

## Human-like timing

Initial configurable targets:

- inbound burst debounce: 7–12 seconds;
- post-draft delivery delay: 30–120 seconds;
- final gate checks newer inbound, human takeover, current mode, service/policy window, draft freshness, account health and idempotency.

## Modes

Per account default and per conversation override:

- `OFF`: mirror only, no AI drafts.
- `DRAFT`: generate and hold for review.
- `AUTOPILOT`: auto-send only when deterministic gates pass.

## Human takeover

Verified manual human reply always wins. Automation pauses for a configurable period or until resumed. Own API echoes must not be mistaken for human sends.

## AI contract

Structured output includes at minimum: `reply`, `confidence`, `should_send`, `needs_review`, `reason_codes[]`, `intent`, `lead_stage`, optional `suggested_action`.

Knowledge and style are separate retrieval domains: style examples influence phrasing, never factual authority.

## Development workflow

- ChatGPT: product/architecture lead, specs, issue decomposition, review, repository memory.
- Claude: primary implementation agent working from issues/specs.
- Codex/Astra: independent tests, migrations, adapters, static/security review, refactors and verification. Avoid two agents editing the same module concurrently.

## Continuity rule

Every material decision, task, completed milestone and unresolved question must be committed into this repository. New sessions should be able to continue from GitHub alone.
