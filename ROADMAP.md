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
- [x] Create Phase 1 implementation issues/contracts

## Phase 1 — Skeleton (implementation entry point)

- [ ] #2 project/monorepo scaffolding — implemented on `feat/p1-01-project-skeleton`, PR #26 open for review
- [ ] #3 domain types/interfaces + channel contracts
- [ ] #4 PostgreSQL/Prisma + Auth.js/workspace isolation
- [ ] #5 BullMQ queue/delay primitives
- [ ] #6 channel-neutral webhook ingestion
- [ ] #7 independent Codex/Astra regression/architecture review

## Phase 2 — Instagram + AI core (fully specified/task-contracted)

- [x] architecture/specs/ADRs/task contracts prepared
- [x] configurable Instagram after-window policy: `STANDARD_ONLY | HUMAN_ASSISTED_EXTENDED`
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

- [ ] human-delay settings UI (`Fast / Natural / Custom`)
- [ ] debounce/delay observability and cancellation UI
- [ ] unified review queue
- [ ] Human Agent review state/expiry UI
- [ ] manual claim/resume controls

## Phase 4 — WhatsApp Cloud API (architecture/backlog/task contracts prepared)

Architecture:
- [x] official Cloud API transport specification
- [x] Embedded Signup onboarding specification + ADR-015
- [x] 24-hour service-window / template-only platform policy captured
- [x] voice/media processing architecture
- [x] read/typing presence architecture
- [x] coexistence/native-human takeover architecture (capability-gated)
- [x] current Meta verification recorded
- [x] Phase 4 issues #18–#25 created
- [x] Phase 4 Claude/Codex task contracts created
- [ ] **Product-owner decision:** accept ADR-016 choice/default for `SERVICE_WINDOW_ONLY` vs `TEMPLATE_ASSISTED`, including whether template-assisted sends require human approval or may auto-send under explicit policy

Implementation:
- [ ] #18 WhatsApp Cloud API transport adapter
- [ ] #19 Embedded Signup/account lifecycle
- [ ] #20 template catalog + outside-window policy
- [ ] #21 media + voice-note processing/transcription
- [ ] #22 read/typing presence timing
- [ ] #23 coexistence/native-human takeover
- [ ] #24 WhatsApp end-to-end AI vertical slice
- [ ] #25 independent Codex/Astra WhatsApp review

## Phase 5 — Unified SaaS UX

- [ ] unified Instagram + WhatsApp inbox
- [ ] channel/account settings
- [ ] knowledge/style configuration
- [ ] lead stages
- [ ] analytics/audit UI
- [ ] cross-channel contact linking only when explicitly verified
- [ ] WhatsApp template/catalog/review UI
- [ ] account health/onboarding status UI

## Phase 6 — Hardening

- [ ] evaluation suite expansion
- [ ] rate limits/quotas
- [ ] reconciliation
- [ ] security review
- [ ] load/failure testing
- [ ] deployment/runbooks
- [ ] privacy/data-retention controls
