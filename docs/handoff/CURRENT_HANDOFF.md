# Current Handoff

**Date:** 2026-09-16  
**Phase:** Phase 1 scaffold PR under architecture revision; Phase 2 Instagram/shared-AI, Phase 4 WhatsApp, Phase 5 SaaS UX and Phase 6 commercial SaaS are specified/task-contracted  
**Repository:** `glebcode1986/omnichannel-ai-setter`

## Current implementation status

PR #26 implements **P1-01 / Issue #2** (`feat/p1-01-project-skeleton`). ChatGPT architecture review submitted `REQUEST_CHANGES` before merge.

### Blocking PR #26 architecture correction

Current scaffold matrix must be changed so:
- `application` depends on `domain` + `channel-core`, **not `ai`**;
- `application` is runtime-agnostic/pure: no Node built-ins/globals/types;
- application owns provider-neutral use-case ports such as future `ReplyModel` / `EmbeddingProvider`;
- `ai` implements those ports and may depend on `application`;
- AI model-output Zod boundary schema/DTO belongs at the application boundary and maps into pure domain values/entities;
- domain does not own provider DTOs and never depends on application/ai.

Accepted PR #26 section-5 interpretations:
- `db` / `queue -> application` allowed for implementing application ports;
- `db -> ai` forbidden;
- `application -> observability` forbidden;
- browser automation dev/test/tooling only.

Claude must fix the same PR/branch, run checks and leave PR open for re-review. **Do not merge and do not start #3 yet.**

No CI status/workflow checks existed on PR #26 at review time. Follow-up Issue #37 adds a GitHub Actions `pnpm verify` gate after the scaffold is accepted.

## Prepared architecture/backlogs

### Phase 2 — Instagram/shared AI
#8–#16 Claude, #17 independent review. Includes Instagram transport/onboarding, provider-neutral AI, separate factual/style retrieval, deterministic policy, delivery coordinator, handoff, evals and E2E.

### Phase 4 — WhatsApp
#18–#24 Claude, #25 review. Official Cloud API + Embedded Signup; accepted after-window modes:
- `SERVICE_WINDOW_ONLY`
- `TEMPLATE_REVIEW`
- `TEMPLATE_AUTOPILOT` with explicit allowlist.

### Phase 5 — SaaS UX
#27–#35 Claude, #36 review. Inbox-first app shell/onboarding, unified Inbox, Review, AI Settings/simulation, Knowledge, Style, Leads, Analytics/Audit, responsive/accessibility E2E.

Knowledge is factual authority; Style is phrasing/tone only and never authorizes facts.

### Phase 6 — Commercial SaaS / billing / usage
#38–#44 Claude, #45 independent review. Specs: `BILLING_ENTITLEMENTS.md`, `USAGE_METERING.md`, `PRICING_PACKAGING.md`, `PHASE6_COMMERCIALIZATION_PLAN.md`.

Accepted commercial architecture:
- ADR-017: billing provider is an adapter behind application-owned provider-neutral ports;
- server-side entitlements are authoritative;
- immutable versioned plan definitions preserve grandfathered meaning;
- ADR-018: customer AI usage is logical `AI_GENERATION_CYCLES`, not raw provider calls/tokens;
- one logical generation may retry/repair without double charging;
- quota exhaustion blocks new AI work but does not drop inbound customer messages;
- delayed automated sends revalidate current entitlement before send;
- downgrade/cancel does not delete data;
- initial packaging shape: Starter / Growth / Scale.

Open owner decisions before production billing:
- billing provider + merchant/legal/payment-jurisdiction strategy (blocks #41);
- public monthly/annual prices + currencies;
- quotas by plan;
- trial duration/card requirement;
- hard stop/top-up/auto-overage behavior;
- annual discount and any advanced feature gating (blocks production values in #43).

## Execution order — immediate

1. Claude fixes PR #26 according to the architecture review.
2. ChatGPT re-reviews updated PR head.
3. Run/complete R1 independent review track.
4. Merge #2 only after acceptance.
5. Add #37 CI verify gate early.
6. Launch P1-02 / Issue #3 from fresh `main` using `docs/tasks/P1-02_CLAUDE_TASK_CONTRACT.md`.

Do not let prepared future phases bypass dependency gates.

## Stable supervisor links

- `docs/tasks/CLAUDE_EXECUTION_QUEUE.md`
- `docs/tasks/README.md`
- exact issue/task contract for each implementation PR.

## Coding rule for every session

Read `PROJECT_CONTEXT.md`, this file, `CLAUDE_EXECUTION_QUEUE.md`, `docs/tasks/README.md`, relevant ADR/spec/research file and exact issue/task contract. Chat history is not the execution source of truth.
