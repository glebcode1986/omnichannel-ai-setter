# Roadmap

## Phase 0 — Architecture & specification (current)

- [x] Establish Instagram + WhatsApp product direction
- [x] Initial Instagram open-source research
- [x] Initial WhatsApp open-source research
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
- [ ] Deep code-path extraction map for OpenSetter and wacrm
- [ ] Finalize monorepo/package layout
- [ ] Finalize auth/workspace model
- [ ] Freeze `ChannelAdapter` and normalized event contracts
- [ ] Produce Phase 1 implementation issues with acceptance criteria

## Phase 1 — Skeleton

- [ ] project/monorepo scaffolding
- [ ] domain types/interfaces
- [ ] PostgreSQL schema/migrations
- [ ] queue abstraction
- [ ] channel adapter interfaces
- [ ] webhook ingestion framework
- [ ] baseline CI/tests

## Phase 2 — Instagram + AI core

- [ ] Instagram connect/webhook/send
- [ ] normalized inbox persistence
- [ ] AI draft engine
- [ ] knowledge/style retrieval
- [ ] safety gates
- [ ] draft/autopilot modes

## Phase 3 — Delay & human handoff

- [ ] debounce
- [ ] randomized delayed delivery
- [ ] final revalidation
- [ ] human takeover
- [ ] review queue

## Phase 4 — WhatsApp Cloud API

- [ ] WABA onboarding/config
- [ ] webhook normalization
- [ ] free-form sends
- [ ] templates/out-of-window handling
- [ ] status/read events
- [ ] interactive/media support

## Phase 5 — Unified SaaS UX

- [ ] unified inbox
- [ ] channel/account settings
- [ ] knowledge/style configuration
- [ ] lead stages
- [ ] analytics/audit UI

## Phase 6 — Hardening

- [ ] evaluation suite
- [ ] rate limits/quotas
- [ ] reconciliation
- [ ] security review
- [ ] load/failure testing
- [ ] deployment/runbooks
