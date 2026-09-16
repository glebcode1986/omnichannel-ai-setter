# Roadmap

## Phase 0 — Architecture & specification

- [x] Establish Instagram + WhatsApp product direction
- [x] Initial Instagram/WhatsApp open-source research
- [x] Official WhatsApp Cloud API decision
- [x] Channel-agnostic core decision
- [x] Durable human-delay principle
- [x] Repository continuity / coding-agent rules
- [x] Verify current Meta platform constraints (2026-09-16)
- [x] Verify OpenSetter + wacrm licenses/anchor commits
- [x] Choose ORM: Prisma 7 + PostgreSQL
- [x] Choose queue: BullMQ 5 + Redis/ioredis
- [x] Prefer Instagram API with Instagram Login
- [x] Exclude Threads DM from MVP until official API exists
- [x] Finalize monorepo/package layout: pnpm workspace
- [x] Finalize MVP auth/workspace model: Auth.js + Prisma WorkspaceMember
- [x] Freeze initial `ChannelAdapter`, normalized event and `SendResult` contracts
- [x] Build file-level upstream extraction map for OpenSetter and wacrm
- [x] Create Phase 1 implementation issues with acceptance criteria

**Phase 0 architecture freeze is complete enough for Phase 1 implementation.** New architectural changes require spec/ADR updates rather than silent code divergence.

## Phase 1 — Skeleton (implementation entry point)

- [ ] #2 project/monorepo scaffolding
- [ ] #3 domain types/interfaces + channel contracts
- [ ] #4 PostgreSQL/Prisma + Auth.js/workspace isolation
- [ ] #5 BullMQ queue/delay primitives
- [ ] #6 channel-neutral webhook ingestion
- [ ] #7 independent Codex/Astra regression/architecture review

Phase 2 coding remains blocked until Phase 1 exit criteria are satisfied.

## Phase 2 — Instagram + AI core (architecture ready)

Design/specification complete:
- [x] Instagram transport/onboarding architecture
- [x] provider-neutral AI contract
- [x] separate factual/style retrieval design
- [x] deterministic policy engine design
- [x] delivery coordinator + ambiguity design
- [x] human handoff/review state design
- [x] configurable Instagram after-window policy: `STANDARD_ONLY | HUMAN_ASSISTED_EXTENDED`
- [x] Phase 2 implementation backlog created

Implementation backlog:
- [ ] #8 Instagram transport adapter + fixtures
- [ ] #9 Instagram Login onboarding/token lifecycle
- [ ] #10 provider-neutral AI draft engine
- [ ] #11 factual + style retrieval
- [ ] #12 deterministic policy engine
- [ ] #13 delivery coordinator/final revalidation
- [ ] #14 human handoff/review state machine
- [ ] #15 evaluation harness/golden conversations
- [ ] #16 Instagram end-to-end AI vertical slice
- [ ] #17 independent Codex/Astra Phase 2 review

## Phase 3 — Productized delay & review UX

Core timing/handoff logic is specified in Phase 2, then productized here:
- [ ] human-delay settings UI (`Fast / Natural / Custom`)
- [ ] debounce/delay observability and cancellation UI
- [ ] unified review queue
- [ ] Human Agent review state/expiry UI
- [ ] manual claim/resume controls

## Phase 4 — WhatsApp Cloud API

- [ ] WABA onboarding/config
- [ ] webhook normalization
- [ ] free-form sends
- [ ] templates/out-of-window handling
- [ ] status/read events
- [ ] typing/read UX
- [ ] interactive/media support
- [ ] voice-note transcription path

## Phase 5 — Unified SaaS UX

- [ ] unified inbox
- [ ] channel/account settings
- [ ] knowledge/style configuration
- [ ] lead stages
- [ ] analytics/audit UI
- [ ] cross-channel contact linking only when explicitly verified

## Phase 6 — Hardening

- [ ] evaluation suite expansion
- [ ] rate limits/quotas
- [ ] reconciliation
- [ ] security review
- [ ] load/failure testing
- [ ] deployment/runbooks
- [ ] privacy/data-retention controls
