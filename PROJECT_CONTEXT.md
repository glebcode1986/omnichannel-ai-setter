# Project Context — Canonical Memory

> Durable project memory. A new AI session must read this file first, then `docs/handoff/CURRENT_HANDOFF.md`, then `docs/tasks/CLAUDE_EXECUTION_QUEUE.md`, `docs/tasks/README.md`, relevant specs/ADRs/issues. Chat history is not the source of truth.

## Goal

Build a commercial SaaS product that handles inbound conversations across Instagram and WhatsApp in the owner's voice, answers from trusted business knowledge, qualifies leads, follows platform policy, escalates uncertain/sensitive cases and hands control to a human cleanly.

## Product direction

One shared conversation/AI/policy/delivery/handoff core with channel adapters. MVP channels: Instagram Messaging API and official WhatsApp Business Cloud API. Threads remains future-only because no supported public Threads DM API was identified in the 2026-09-16 verification.

## Verified platform constraints — 2026-09-16 baseline

### Instagram
- professional accounts via Instagram API with Instagram Login;
- inbound-first messaging;
- after-window Human Agent support is a separately eligible/approved human-support path and must be re-verified at implementation/App Review time.

### WhatsApp
- production transport is official WhatsApp Cloud API only;
- customer message opens the current platform-defined customer-service window (currently 24 hours) for supported free-form customer-care replies;
- outside free-form window, approved message templates are the supported provider mechanism rather than arbitrary free-form continuation;
- official Messages API supports text, media including audio, templates, read receipts, typing indicator and webhook delivery/read statuses;
- SaaS client onboarding uses current Meta Embedded Signup/business asset flow;
- coexistence with an existing WhatsApp Business App number is modeled as capability-gated, not universally assumed.

See `docs/research/META_API_VERIFICATION.md`, `META_INSTAGRAM_PHASE2_VERIFICATION.md`, and `META_WHATSAPP_PHASE4_VERIFICATION.md`.

## Instagram after-window product choice — Accepted

Support both:
- `STANDARD_ONLY`;
- `HUMAN_ASSISTED_EXTENDED` — AI may prepare draft; real human explicitly reviews/edits/approves and initiates an eligible tagged Human Agent send.

A background AI worker does not silently label itself as `HUMAN_AGENT`. See ADR-014.

## WhatsApp after-window product choice — Accepted

ADR-016 is Accepted. Expose all three account/workspace-selectable modes:

- `SERVICE_WINDOW_ONLY` — no outside-window customer delivery until the customer reopens the free-form service window;
- `TEMPLATE_REVIEW` — system may select/prepare an eligible approved template, but an authorized human approves the send;
- `TEMPLATE_AUTOPILOT` — deterministic policy may auto-send only current approved templates/use-cases explicitly allowlisted for automation.

No explicit stored choice means conservative `SERVICE_WINDOW_ONLY` behavior until configured. `TEMPLATE_AUTOPILOT` with an empty allowlist sends nothing unattended. Current consent/template/account-health/STOP rules remain authoritative and are revalidated immediately before send.

## Open-source references

- **OpenSetter** (`xbirimensah/opensetter`, anchor `aa7d97c38b6d6698df1202d87c00fef5c983cfcb`, MIT) — AI setter/queue/send/handoff reference.
- **wacrm** (`ArnasDon/wacrm`, anchor `80c3f9a1aecdaf21b98311f230fdaaaec7d85f7d`, MIT) — official WhatsApp Cloud API webhook/send/template/media/signature/inbox patterns.
- **InstaAuto** — UX/automation patterns; verify license/commit before code reuse.
- **Claude Instagram Bot** — qualification/voice/handoff ideas; verify license/commit before code reuse.
- **Senqo** — agent/inbox/CRM/eval ideas only; reject Baileys/QR production transport.

All source reuse requires file-level attribution in `THIRD_PARTY.md`.

## Accepted architecture

- channel-neutral domain/application core and `ChannelAdapter` boundary;
- TypeScript, Next.js 16/React 19, pnpm workspace;
- Prisma 7 + PostgreSQL;
- BullMQ 5 + Redis/ioredis;
- Auth.js + Prisma WorkspaceMember tenancy;
- webhooks verify/normalize/persist/enqueue and ACK quickly;
- AI generation and delivery are separate;
- provider-neutral schema-validated AI contract;
- factual knowledge and style memory are separate retrieval domains;
- deterministic policy engine owns send/review eligibility;
- one delivery coordinator owns natural delay, final revalidation, atomic claim and send-result handling;
- manual human activity wins and pauses/cancels automation;
- ambiguous provider send outcomes are quarantined, never blindly retried;
- WhatsApp onboarding is official Embedded Signup; no password/QR/session scraping;
- WhatsApp voice-note understanding is media fetch + separate transcription provider + shared AI core;
- WhatsApp read/typing presence is best-effort UX near delivery, not a replacement for durable delay;
- platform-specific policy facts stay in channel adapters/policy inputs, not prompts.

## Human-like timing

Initial targets: inbound burst debounce 7–12 seconds; post-draft delivery delay 30–120 seconds with a non-uniform natural distribution. Final pre-send gate always rechecks newer inbound, takeover, mode, policy/window, draft freshness, account health and idempotency.

## Modes

- `OFF`: mirror only;
- `DRAFT`: generate and hold;
- `AUTOPILOT`: auto-send only when deterministic gates pass.

After-window policies are separate from AiMode.

## Development workflow

- ChatGPT: product/architecture lead, research/specs/issues/task contracts/review/durable memory.
- Claude: primary implementation agent, one issue/task contract at a time, PR only, no self-merge.
- Codex/Astra: independent reviewer/test author by default, especially concurrency/security/idempotency/adversarial coverage.
- Human programmer/supervisor can use `docs/tasks/CLAUDE_EXECUTION_QUEUE.md` as the stable launch/monitoring page for Claude.

## Current execution state

- Phase 0 complete.
- Claude is currently working on Phase 1 Issue #2 / P1-01; no open PR was visible when this context was updated.
- P1-02 / Issue #3 is fully prepared and may start only after #2 is reviewed/accepted/merged into `main`.
- Phase 1 issues #2–#6 + review #7 remain the current coding path.
- Phase 2 Instagram/shared-AI architecture, issues #8–#17 and task contracts are fully prepared but coding waits for Phase 1 exit criteria.
- Phase 4 WhatsApp architecture, current Meta verification, issues #18–#25 and task contracts are prepared; ADR-016 is Accepted with all three outside-window modes.

## Continuity rule

Every material decision, task, completed milestone and unresolved question must be committed into this repository. New sessions continue from GitHub alone.
