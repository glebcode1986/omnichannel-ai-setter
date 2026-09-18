# Omnichannel AI Setter

> **NEW SESSION / NEW AGENT: start with [`docs/handoff/CURRENT_HANDOFF.md`](docs/handoff/CURRENT_HANDOFF.md).** It is the canonical current-stage handoff, including live implementation stage, review blockers, accepted product decisions and next actions. Fetch live PR HEADs before acting.

A multi-channel AI sales/support setter for Instagram and WhatsApp, designed as a SaaS product rather than a single-account bot.

## Product thesis

One AI brain, multiple messaging channels. Instagram and WhatsApp are adapters around a shared conversation engine, knowledge base, style memory, safety layer, delayed delivery engine, and human handoff workflow.

## MVP channels

- Instagram Messaging API
- WhatsApp Business Cloud API (official Meta API only)

Future channels should be addable through the same `ChannelAdapter` contract without rewriting the AI core.

## Core principles

1. **Channel-agnostic core** — no Instagram-specific business logic in the AI/domain layer.
2. **Official platform APIs in production** — no WhatsApp Web/Puppeteer/Baileys transport for the SaaS product.
3. **Human-like, not instant** — delayed replies with debounce, random delivery windows and revalidation before send.
4. **Human override always wins** — manual owner/agent activity pauses automation for that conversation.
5. **Fail safe** — uncertain, sensitive, ambiguous or unsupported cases are held for review.
6. **Persistent project memory** — architecture, decisions, research and implementation instructions live in this repository, not only in chat history.
7. **Agent-friendly development** — Claude/Codex/Astra should be able to continue from repository docs alone.

## Documentation map

- `PROJECT_CONTEXT.md` — canonical project memory and current state
- `CLAUDE.md` — implementation instructions for Claude
- `AGENTS.md` — rules for any coding agent (Claude, Codex, Astra, Cursor, etc.)
- `docs/specs/PRODUCT_REQUIREMENTS.md` — product requirements
- `docs/specs/ARCHITECTURE.md` — target architecture
- `docs/specs/TECHNICAL_SPEC.md` — technical specification
- `docs/specs/AI_BEHAVIOR.md` — AI behavior and safety contract
- `docs/specs/DELAY_ENGINE.md` — debounce / human-delay design
- `docs/specs/DATA_MODEL.md` — domain entities and persistence model
- `docs/research/OPEN_SOURCE_RESEARCH.md` — analyzed open-source references
- `docs/adr/` — architecture decision records
- `docs/handoff/CURRENT_HANDOFF.md` — latest continuation point for a new chat/session
- `ROADMAP.md` — phased development plan

## Current status

Active implementation. The project is in **Stage B — Instagram + shared AI**.

Implemented in the current stacked train:
- Business Profile-aware Phase 1 foundation;
- Instagram transport;
- Instagram onboarding/token lifecycle;
- provider-neutral AI draft engine;
- factual/style retrieval;
- deterministic policy engine.

Current independent-review gate is **PR #50**; the production row-lock fix is in place, but Astra still requires the forced PostgreSQL regression to persist both real inbound messages in the same deterministic schedule. Owner follow-ups on PRs #65/#66/#67 are also pending before/with Delivery Coordinator #13.

Do not use this README as an exact SHA ledger. Read `docs/handoff/CURRENT_HANDOFF.md`, then fetch live GitHub state.
