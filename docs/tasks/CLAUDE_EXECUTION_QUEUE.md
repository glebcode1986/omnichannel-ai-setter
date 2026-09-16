# Claude Execution Queue

> Stable handoff page for the human programmer supervising Claude. Always read this file together with the linked task contract and GitHub issue. Chat history is not the execution source of truth.

## Current task — PR #26 CHANGES REQUESTED

### P1-01 — Issue #2: Scaffold pnpm workspace and baseline tooling

PR: `#26`  
Branch: `feat/p1-01-project-skeleton`  
Contract: [`P1-01_CLAUDE_TASK_CONTRACT.md`](./P1-01_CLAUDE_TASK_CONTRACT.md)

ChatGPT architecture review submitted `REQUEST_CHANGES`.

Claude must fix the same branch/PR, run required checks and keep the PR open. Do **not** start #3 and do not merge #26 until the updated head is re-reviewed and accepted.

### Required PR #26 correction

- remove `application -> ai` dependency direction;
- make `application` runtime-agnostic/pure (no Node built-ins/globals/types);
- application owns future provider-neutral AI ports (`ReplyModel`, `EmbeddingProvider`);
- `ai -> application` is allowed for infrastructure implementation;
- AI model-output Zod boundary schema/DTO belongs at application boundary and maps to pure domain values/entities;
- align ADR-010, `AI_ORCHESTRATION.md`, repository dependency rules/docs and future P2-03 contract wording.

Accepted ambiguity decisions: `db/queue -> application`; no `db -> ai`; no `application -> observability`; browser automation dev/test/tooling only.

## Early infra follow-up after #2

### Issue #37 — GitHub Actions `pnpm verify` gate

Add CI early after the scaffold is accepted so future PRs automatically run frozen-lockfile install + repository verify. This may be done before or alongside early Phase 1 follow-up as long as it does not overlap Claude-owned feature modules.

## Next feature task — ONLY AFTER #2 MERGE

### P1-02 — Issue #3: Domain model and channel contracts

Contract: [`P1-02_CLAUDE_TASK_CONTRACT.md`](./P1-02_CLAUDE_TASK_CONTRACT.md)  
Branch: `feat/p1-02-domain-channel-contracts`

Supervisor launch instruction after #2 merge:

```text
Open repository glebcode1986/omnichannel-ai-setter.
Pull the latest main after Issue #2 has been accepted and merged.
Read docs/tasks/P1-02_CLAUDE_TASK_CONTRACT.md and execute it exactly.
Implement only GitHub Issue #3 on branch feat/p1-02-domain-channel-contracts.
Run every verification required by the contract and open a PR into main.
Do not merge the PR and do not begin Issue #4 or #5.
```

## Queue after P1-02

1. P1-03 / #4 — Prisma + Auth.js + workspace isolation.
2. P1-04 / #5 — BullMQ durable queue/delay primitives; may parallelize with #4 only after #3/shared IDs stabilize and modules do not overlap.
3. P1-05 / #6 — channel-neutral webhook ingestion after #3/#4/#5.
4. R1 / #7 — independent Codex/Astra review throughout Phase 1.

## Prepared future phases

### Phase 2 — Instagram + shared AI
Contracts `P2-*`, Issues #8–#16 + #17 review. Start only after Phase 1 exit unless architecture is explicitly amended.

### Phase 4 — WhatsApp
Contracts `P4-*`, Issues #18–#24 + #25 review. Accepted modes: `SERVICE_WINDOW_ONLY | TEMPLATE_REVIEW | TEMPLATE_AUTOPILOT`.

### Phase 5 — SaaS UX
Contracts `P5-*`, Issues #27–#35 + #36 review. May start incrementally only when each backend dependency is stable.

### Phase 6 — Commercial SaaS / billing / usage
Contracts `P6-*`, Issues #38–#44 + #45 review.

Provider-neutral entitlement/usage work may start when domain/application/DB prerequisites are stable. Billing-provider Issue #41 remains blocked until the product owner selects provider + merchant/legal/payment strategy. Production plan catalog #43 remains blocked until prices/quotas/trial/overage choices are accepted.

## Supervisor rule

After every Claude PR:
1. stop before merge;
2. run ChatGPT architecture review against issue + contract;
3. run applicable Codex/Astra independent review;
4. fix blocking findings on the same branch;
5. merge only after acceptance;
6. update queue/current handoff when state materially changes.
