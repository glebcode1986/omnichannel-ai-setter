# Claude Execution Queue

> Stable execution page for Claude and the supervising human. GitHub issues/specs are the source of truth; chat is not. Always read the exact issue + linked task contract + current canonical specs before coding.

## Current status — Phase 1 code exists, but Business Profile sync is required before Phase 2

Observed open stack:

- PR #26 / Issue #2 — scaffold — HEAD last observed `b2f650351b473b49b8b893045a8b07c97882f9a0`
- PR #49 / Issue #3 — domain/channel contracts — stacked on #26
- PR #50 / Issue #4 — Prisma/Auth — stacked on #49
- PR #51 / Issue #5 — BullMQ — stacked on #50
- PR #52 / Issue #6 — webhook ingestion — HEAD last observed `89502864a6bc77c3005543e2894d76399f13c1b8`, stacked on #51

**Do not treat these observed SHAs as permanent. Fetch the live parent HEAD before every branch update.**

The existing Phase 1 stack was implemented before accepted `DATA_MODEL.md` v0.4 Business Profile semantics fully propagated. Phase 2 is blocked on correcting the existing stack.

## NEXT TASK — Issue #53 P1-SYNC

Issue: `#53 [P1-SYNC] Align open Phase 1 stack with Business Profile / Data Model v0.4`  
Contract: [`P1-BP-SYNC_CLAUDE_TASK_CONTRACT.md`](./P1-BP-SYNC_CLAUDE_TASK_CONTRACT.md)

Execute in exact dependency order:

1. update PR #49 (`feat/p1-02-domain-channel-contracts`);
2. merge corrected #49 into PR #50 branch, then update/verify #50;
3. merge corrected #50 into PR #51 branch, then update/verify #51;
4. merge corrected #51 into PR #52 branch, then update/verify #52.

Preserve published stack ancestry. Use normal merges for parent propagation; do not force-push/rebase merely to make history pretty.

Required model:
- Workspace = tenant/billing boundary;
- Business Profile = operational/customer-data boundary;
- Contact is BP-scoped by default;
- ChannelAccount/ChannelIdentity/Conversation and policy-critical queued work preserve Workspace + BP scope;
- role = what; BP access = where;
- no cross-BP customer merge/search disclosure by default;
- conversation state/version supports stale-action protection.

Every corrected PR must run complete branch-appropriate verification and publish:

`CLAUDE_READY_FOR_ASTRA head=<full_sha> task=<P1-xx>`

## Temporary independent-review protocol

Astra/Codex review is temporarily asynchronous because reviewer quota is constrained.

Claude must:
- self-verify rigorously;
- record exact HEAD SHAs;
- leave exact-head Astra markers;
- continue to the next dependency-safe task without waiting for Astra after each iteration.

Claude must **not**:
- claim Astra PASS without an actual independent exact-head review;
- merge child PRs before parents;
- merge its own feature PRs to `main` without human/project-owner authority;
- weaken verification because review is delayed.

## After Issue #53

### #37 — GitHub Actions `pnpm verify` gate

Add the minimal CI gate on top of the corrected Phase 1 stack. If Claude's credential still cannot write `.github/workflows/*`, report the exact permission blocker and continue with full local verification; do not silently omit the gate from the roadmap.

### Phase 1 exit gate

Before starting Phase 2, the corrected stack must demonstrate:
- fake channel webhook -> verify -> normalize -> BP-scoped persistence -> transactional outbox/queue;
- DB + Redis integration suites green;
- Workspace and BP isolation adversarial tests;
- duplicate/reordered event idempotency;
- human/manual echo fail-safe takeover semantics;
- no blind retry after ambiguous external write;
- no LLM or artificial delay inside webhook lifecycle.

## Master MVP build train

GitHub Issue **#61** is the ordered execution index from current sync to Commercial Beta. Follow its stage order unless the product owner explicitly changes priority.

Default stages:

1. **A — Phase 1 sync + CI:** #53, then #37.
2. **B — Instagram + shared AI:** #8 -> #9 -> #10 -> #11 -> #12 -> #13 -> #14 -> #15 -> #16.
3. **C — Reliability before broad AUTOPILOT:** #56.
4. **D — Design Partner UI:** #27 -> #58 -> #28 -> #29 -> #31 -> #32 -> #30 -> #33 -> #54 -> #55 -> #34 -> #35.
5. **E — WhatsApp:** #18 -> #19 -> #20 -> #21 -> #22 -> #23 -> #24.
6. **F — Privacy/security hardening:** #57.
7. **G — Commercial billing:** #38 -> #43 -> #39 -> #40 -> #46 -> provider decision -> #41 -> #47 -> #42 -> #44.
8. **H — Admin Operations:** #59.
9. **I — Launch readiness / Commercial Beta:** #60 plus independent-review catch-up.

Independent review queues: #7, #17, #25, #36, #45, #48. They may lag during the temporary protocol, but release evidence must never pretend unreviewed SHAs passed.

## Design Partner Alpha gate

A tightly controlled Instagram design partner can begin before the entire commercial MVP is complete when all of the following are true:
- Instagram end-to-end path is green;
- #56 kill switches/reliability minimum exists;
- app shell/onboarding, Inbox, Review, Knowledge, Style and Test Drive are operational (#27/#28/#29/#31/#32/#30);
- DRAFT is default;
- Workspace/BP isolation is adversarially tested;
- no production secret handling gap is knowingly open.

Do not wait for booking/public API/prospecting product for Design Partner Alpha.

## Hard invariants — never cut these for speed

- Workspace + Business Profile isolation;
- human activity always wins over AI automation;
- stale draft/review/action protection;
- model output is advisory; deterministic application policy authorizes sends/actions;
- no blind retry after ambiguous provider/external write;
- idempotent provider/webhook/job processing;
- inbound customer data persists when AI/billing/dependencies are blocked;
- AUTOPILOT executes server-side with dashboard/browser closed;
- queues are execution mechanisms, not the sole durable intent store;
- secrets never enter prompts, client output, normal logs or plaintext audit;
- do not implement Later features merely because Data Model contains extension points.

## Per-task protocol

For every task:
1. fetch live parent/base state and exact HEAD;
2. read `PROJECT_CONTEXT.md`, current handoff, `AGENTS.md`, `CLAUDE.md`;
3. read exact GitHub issue, task contract, relevant ADRs/specs;
4. implement only the bounded issue;
5. add success, failure, tenant/BP, stale/race/idempotency tests required by the contract;
6. run full affected infrastructure tests plus root verify;
7. perform targeted adversarial/mutation checks on critical invariants;
8. open/update a narrow PR against the correct parent branch;
9. record real deviations only when an actual contract ambiguity is discovered;
10. publish exact `CLAUDE_READY_FOR_ASTRA` marker and proceed to the next dependency-safe task.

## Scope guard

Architecture is broader than MVP. Booking, public Platform API/webhooks, broad CRM connectors, acquisition/prospecting, Telegram/Threads and AI-generated voice/media are not on the first Commercial Beta critical path unless the product owner explicitly reprioritizes them.
