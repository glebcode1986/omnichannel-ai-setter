# Project Context — Canonical Memory

> Durable project memory. A new AI session must read this file first, then `docs/handoff/CURRENT_HANDOFF.md`, `docs/tasks/CLAUDE_EXECUTION_QUEUE.md`, `docs/tasks/README.md`, relevant specs/ADRs/issues. Chat history is not the source of truth.

## Goal

Build a commercial SaaS product that handles inbound conversations across Instagram and WhatsApp in the owner's voice, answers from trusted business knowledge, qualifies leads, follows platform policy, escalates uncertain/sensitive cases and hands control to a human cleanly.

## Product direction

One shared conversation/AI/policy/delivery/handoff core with channel adapters. MVP channels: Instagram Messaging API and official WhatsApp Business Cloud API. Threads remains future-only because no supported public Threads DM API was identified in the 2026-09-16 verification.

The SaaS UX is **Inbox-first**: one unified operational inbox is the primary daily workspace, with Review, Leads, Knowledge, Style, Analytics and Settings as supporting surfaces. Instagram and WhatsApp render through the same product shell with capability-specific states rather than separate dashboards.

## Platform choices — Accepted

### Instagram
- professional accounts via Instagram API with Instagram Login;
- inbound-first messaging;
- after-window product modes: `STANDARD_ONLY | HUMAN_ASSISTED_EXTENDED` (ADR-014);
- extended mode is real-human review/send under current eligible Human Agent rules, not unattended AI impersonation.

### WhatsApp
- production transport is official Cloud API only;
- Embedded Signup for SaaS onboarding (ADR-015);
- customer-service free-form window currently 24 hours; outside it use approved template mechanisms under current policy;
- after-window modes: `SERVICE_WINDOW_ONLY | TEMPLATE_REVIEW | TEMPLATE_AUTOPILOT` (ADR-016);
- autopilot requires an explicit allowlist; no stored choice means conservative service-window-only behavior.

Re-verify current Meta rules/scopes/API behavior at implementation/App Review time.

## SaaS UX architecture — Prepared

Phase 5 specs/issues/contracts #27–#36 cover app shell/onboarding, unified Inbox, first-class Review queue, AI settings/simulation, separate Knowledge/Style management, Leads, Analytics/Audit and responsive/accessibility E2E.

Knowledge answers what is true; Style answers how the business sounds. They remain separate storage/retrieval/UI domains.

## Commercial SaaS architecture — Prepared

Phase 6 specs/ADRs/issues/contracts #38–#45 are prepared.

Accepted decisions:
- billing/payment provider is an adapter behind application-owned provider-neutral ports (ADR-017);
- server-side entitlement state is authoritative; UI state is never authorization;
- plan definitions are versioned/immutable so grandfathered subscriptions retain meaning;
- customer-facing AI usage is metered by logical generation operations, not raw provider requests/tokens (ADR-018);
- one logical generation cycle can retry/repair provider output without double-charging;
- inbound customer messages continue to ingest/persist when quota/subscription blocks AI;
- delayed automated sends revalidate current entitlement before send;
- downgrade/cancel never deletes customer data merely to meet a commercial limit;
- initial packaging shape is Starter / Growth / Scale, but actual prices, quotas, currencies, trial, overage and billing provider remain explicit owner decisions before production billing.

Concrete billing-provider Issue #41 is blocked until provider + merchant/legal/payment-jurisdiction strategy is selected. Production plan-values Issue #43 is blocked until pricing/quota/trial/overage decisions are accepted.

## Architecture review decision from PR #26 — pending implementation in that PR

ChatGPT architecture review requested one blocking correction before Issue #2 can merge:
- `application` must **not** depend on `ai`;
- `application` owns provider-neutral use-case ports such as `ReplyModel`/`EmbeddingProvider` when implemented;
- `ai`, `db`, `queue` are infrastructure implementations and may depend on `application` ports;
- `application` remains runtime-agnostic/pure with no Node built-ins/globals/types;
- model-output Zod boundary schema/DTO belongs at the application boundary, then maps to pure domain values/entities; domain does not own provider DTOs and does not depend on `ai`/application.

Section-5 decisions accepted from PR #26: `db/queue -> application` allowed; `db -> ai` forbidden; `application -> observability` forbidden; browser automation test/dev-only. PR #26 currently has a `REQUEST_CHANGES` architecture review and must be re-reviewed before merge.

## Open-source references

- **OpenSetter** (`xbirimensah/opensetter`, anchor `aa7d97c38b6d6698df1202d87c00fef5c983cfcb`, MIT) — AI setter/queue/send/handoff reference.
- **wacrm** (`ArnasDon/wacrm`, anchor `80c3f9a1aecdaf21b98311f230fdaaaec7d85f7d`, MIT) — official WhatsApp Cloud API webhook/send/template/media/signature/inbox patterns.
- InstaAuto / Claude Instagram Bot / Senqo are idea references only unless license/anchor is verified for any code reuse; reject unofficial WhatsApp Web/Baileys production transport.

All source reuse requires file-level attribution in `THIRD_PARTY.md`.

## Core architecture

- TypeScript, Next.js 16/React 19, pnpm workspace;
- Prisma 7 + PostgreSQL;
- BullMQ 5 + Redis/ioredis;
- Auth.js + Prisma WorkspaceMember tenancy;
- channel-neutral domain/application core + `ChannelAdapter` boundary;
- webhooks verify/normalize/persist/enqueue and ACK quickly;
- AI generation and delivery are separate;
- factual knowledge and style memory are separate retrieval domains;
- deterministic policy engine owns send/review eligibility;
- durable 7–12s inbound debounce and 30–120s post-draft natural delay targets;
- final pre-send revalidation checks newer inbound, takeover, mode, channel policy/window, entitlement, draft freshness, account health and idempotency;
- ambiguous provider send outcomes are quarantined, never blindly retried;
- manual human activity wins and pauses/cancels automation.

## Modes

- `OFF`: mirror only;
- `DRAFT`: generate and hold;
- `AUTOPILOT`: auto-send only when deterministic gates pass.

Channel after-window policy and commercial entitlement are separate from `AiMode`.

## Development workflow

- ChatGPT: product/architecture lead, research/specs/issues/task contracts/review/durable memory.
- Claude: primary implementation agent, one issue/task contract at a time, PR only, no self-merge.
- Codex/Astra: independent reviewer/test author by default, especially concurrency/security/idempotency/adversarial coverage.
- Human programmer/supervisor uses `docs/tasks/CLAUDE_EXECUTION_QUEUE.md` as the stable launch/monitoring page.

## Current execution state

- PR #26 implements P1-01 / Issue #2 and is open. Architecture review requested changes; do not merge/start #3 until corrected head is re-reviewed and accepted.
- #37 adds an early GitHub Actions `pnpm verify` gate after the scaffold is accepted.
- P1-02 / Issue #3 is prepared for fresh `main` after #2 merge.
- Phase 2 Instagram/shared-AI #8–#17, Phase 4 WhatsApp #18–#25, Phase 5 SaaS UX #27–#36 and Phase 6 commercial SaaS #38–#45 are architected/task-contracted subject to their dependency gates.

## Continuity rule

Every material decision, task, completed milestone and unresolved question must be committed into the repository. New sessions continue from GitHub alone.
