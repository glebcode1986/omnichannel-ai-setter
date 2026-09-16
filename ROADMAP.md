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

- [ ] #2 project/monorepo scaffolding — PR #26 under architecture review
- [ ] #3 domain types/interfaces + channel contracts
- [ ] #4 PostgreSQL/Prisma + Auth.js/workspace isolation
- [ ] #5 BullMQ queue/delay primitives
- [ ] #6 channel-neutral webhook ingestion
- [ ] #7 independent Codex/Astra regression/architecture review
- [ ] #37 GitHub Actions `pnpm verify` CI gate (early follow-up after #2)

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

Phase 3 concerns are represented as reusable backend behavior in Phase 2 and concrete product surfaces in Phase 5. Keep this as a tracking bridge rather than re-implementing the same logic.

- [x] timing/review UX requirements incorporated into Phase 5 specs
- [x] manual claim/resume and Human Agent review state incorporated into P5-03/P5-04

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
- [x] ADR-016 accepted with `SERVICE_WINDOW_ONLY | TEMPLATE_REVIEW | TEMPLATE_AUTOPILOT`

Implementation:
- [ ] #18 WhatsApp Cloud API transport adapter
- [ ] #19 Embedded Signup/account lifecycle
- [ ] #20 template catalog + outside-window policy
- [ ] #21 media + voice-note processing/transcription
- [ ] #22 read/typing presence timing
- [ ] #23 coexistence/native-human takeover
- [ ] #24 WhatsApp end-to-end AI vertical slice
- [ ] #25 independent Codex/Astra WhatsApp review

## Phase 5 — Unified SaaS UX (architecture/backlog/task contracts prepared)

Architecture:
- [x] inbox-first product UX architecture
- [x] resumable onboarding flow
- [x] AI settings + no-send simulation design
- [x] separate Knowledge and Style management UX
- [x] lead pipeline + qualification UX
- [x] operational analytics + audit UX
- [x] responsive/accessibility/E2E requirements
- [x] Phase 5 issues #27–#36 created
- [x] Phase 5 Claude/Codex task contracts created

Implementation:
- [ ] #27 app shell + resumable onboarding
- [ ] #28 unified omnichannel Inbox
- [ ] #29 conversation operations + Review Queue
- [ ] #30 AI Settings + no-send simulation playground
- [ ] #31 versioned Knowledge Library + retrieval tester
- [ ] #32 Style Training + verified examples
- [ ] #33 Leads pipeline + qualification workspace
- [ ] #34 operational Analytics + searchable Audit
- [ ] #35 SaaS UX E2E/responsive/accessibility pass
- [ ] #36 independent Codex/Astra Phase 5 review

Phase 5 may begin incrementally as backend dependencies stabilize; it does not need to wait for every WhatsApp feature.

## Phase 6 — Commercial SaaS / billing / usage (architecture/backlog/task contracts prepared)

Architecture:
- [x] provider-neutral billing/entitlement boundary — ADR-017
- [x] logical-operation usage ledger — ADR-018
- [x] usage/quota reservation specification
- [x] Starter/Growth/Scale packaging model
- [x] downgrade/cancel/trial/grace invariants
- [x] Phase 6 issues #38–#45 created
- [x] Phase 6 Claude/Codex task contracts created

Implementation:
- [ ] #38 plan/subscription/entitlement domain + persistence
- [ ] #39 idempotent usage ledger + quota reservation
- [ ] #40 entitlement enforcement across AI/channels/delayed delivery
- [ ] #41 billing provider adapter + verified webhook lifecycle — blocked until provider/jurisdiction decision
- [ ] #42 billing/plan/usage settings UI
- [ ] #43 versioned Starter/Growth/Scale plan catalog — production values blocked on owner pricing decisions
- [ ] #44 commercial billing/quota E2E slice
- [ ] #45 independent Codex/Astra billing/entitlement review

Open owner decisions before production billing:
- billing provider + merchant/legal/payment jurisdiction strategy;
- monthly/annual prices + currencies;
- quotas per plan;
- trial duration/card requirement;
- overage model + annual discount;
- which advanced features, if any, are commercially gated beyond capacity/usage.

## Phase 7 — Hardening / launch readiness

- [ ] evaluation suite expansion
- [ ] platform/provider rate limits and quotas
- [ ] reconciliation expansion
- [ ] security review
- [ ] load/failure testing
- [ ] deployment/runbooks
- [ ] privacy/data-retention controls
- [ ] backup/restore/disaster recovery
- [ ] operational alerts/SLOs
