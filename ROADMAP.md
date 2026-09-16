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

## Phase 1 — Skeleton (ready to start)

- [ ] #2 project/monorepo scaffolding
- [ ] #3 domain types/interfaces + channel contracts
- [ ] #4 PostgreSQL/Prisma + Auth.js/workspace isolation
- [ ] #5 BullMQ queue/delay primitives
- [ ] #6 channel-neutral webhook ingestion
- [ ] #7 independent Codex/Astra regression/architecture review

## Phase 2 — Instagram + AI core

- [ ] Instagram connect/webhook/send
- [ ] normalized inbox persistence
- [ ] AI draft engine
- [ ] knowledge/style retrieval
- [ ] safety gates
- [ ] draft/autopilot modes

## Phase 3 — Delay & human handoff

- [ ] debounce product behavior
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
