# Open-source Research — v0.2

## Selection criteria

We care about reusable architecture/product patterns, not blindly merging repositories. Prefer official platform transports, clear licenses, typed/domain-separated code, durable jobs, safety/handoff, tests and maintainability.

## OpenSetter

Primary conceptual AI-setter reference. Useful patterns: OFF/DRAFT/AUTOPILOT, per-thread override, confidence plus deterministic gates, separate factual/style memory, debounce, stale supersession, human takeover, no-double-send, ambiguous-send quarantine and reconciliation. Required refactor: remove Instagram-specific semantics from core and move service-window logic behind channel policy.

## InstaAuto

Useful for unified inbox/automation UX, DM/comment/story triggers, quick replies/media/typing indicators and configurable delays. Do not reproduce long in-request sleeps; durable delayed jobs are required.

## Claude Instagram Bot

Useful for lead qualification, owner voice/rate-card playbooks, `needs_human`/off-topic signals, owner alerts, voice-note transcription and lead summaries.

## wacrm (`ArnasDon/wacrm`)

High-value WhatsApp reference built around official Meta API patterns. Repository structure includes dedicated WhatsApp webhook, send, templates, media, interactive-message, signature-verification, phone/identity, broadcast and error-explanation modules; AI modules include draft/autoreply, knowledge retrieval, provider abstractions and handoff; it also contains Supabase migrations, inbox/CRM/pipeline/automation UI and substantial tests.

What to study first:

1. webhook signature verification + normalization;
2. conversation resolution/idempotency;
3. `meta-api`/send result handling;
4. template lifecycle and service-window enforcement;
5. inbound media mirroring;
6. AI handoff/knowledge/provider boundaries;
7. database constraints and failure-state modeling.

Do not copy code until license and exact upstream commit/file attribution are recorded in `THIRD_PARTY.md`.

## Senqo

Useful ideas: shared inbox, CRM, reusable agents/knowledge, human handoff, agent evaluations and jobs. Its WhatsApp transport uses Baileys/QR-linked sessions, so transport code is rejected for production.

## Community WhatsApp Cloud inbox projects

Useful for template parameter UX, interactive messages, media, failed-message visibility and service-window awareness. Official Meta docs remain normative.

## Unofficial WhatsApp Web projects

Can inform UX/session concepts but are not acceptable production transport because of reliability, supportability and account/policy risk.
