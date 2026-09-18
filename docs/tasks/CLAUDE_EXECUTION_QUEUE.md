# Claude Execution Queue

> Stable execution page for Claude and the supervising human. GitHub issues/specs are source of truth; chat is not.
>
> **Always read `docs/handoff/CURRENT_HANDOFF.md` first. It is the current-stage ledger.**

## Current status — 2026-09-18

Stage B (Instagram + shared AI) is active.

Implemented in the current stack:
- #8 Instagram transport adapter;
- #9 Instagram onboarding/token lifecycle;
- #10 provider-neutral AI draft engine;
- #11 factual + style retrieval;
- #12 deterministic policy engine.

Current earliest unresolved independent-review dependency: **PR #50 / P1-03**.

Do not treat SHAs below as permanent. Fetch live PR metadata before every update.

### Current stack snapshot

- #49 P1-02 — `34a71d0d36b04f2c8933aa29479e26cbc87e7800` — Astra PASS
- #50 P1-03 — `a3eebd62c5ee0d2e80b053ace43549425a08d6e6` — Astra CHANGES_REQUESTED
- #51 P1-04 — `f45bb14aa14929696a07e00a6b3ebd1664191fd0`
- #52 P1-05 — `9533b0a2a2fb26591d976788d45521cefbd6d717`
- #63 P2-01 — `2d7bcd768ea96ee91e532e7a772408970b89b559`
- #64 P2-02 — `ac318f34ed3dc9f3b962174250fbeb0aa4ddeaf8`
- #65 P2-03 — `d58ada0d57f730f7ea26517f2db30f988d55bbdd`
- #66 P2-04 — `c6972c7212792f68b8538e3cecddbc29cd542602`
- #67 P2-05 — `015433c33bf02efb865248ed03c06784f87158a5`

## Immediate priority A — close PR #50 review gate

Production row-lock fix is accepted in principle. Remaining review gap is the deterministic concurrency regression.

The current test must be changed so the **same forced PostgreSQL interleaving contains two real inbound messages**, not one repository append plus one synthetic Conversation-only update.

Required proof:
1. preserve the PostgreSQL-observed lock-wait barrier;
2. holder/newer side must persist a real inbound Message and perform the matching Conversation transition in the same transaction (paused repository transaction or equivalent faithful SQL setup);
3. older side uses the actual repository append path;
4. assert exactly two new inbound message rows;
5. assert stateVersion +2;
6. assert lastInboundAt/lastMessageAt equal the newer message timestamp;
7. explicit fresh-conversation `lastInboundAt = NULL` case;
8. no-lock mutation must fail deterministically.

Publish:

`CLAUDE_READY_FOR_ASTRA head=<new-full-sha> task=P1-03`

Then propagate with **normal merges only** through all current child branches.

Astra re-reviews #50 first; downstream acceptance remains queued.

## Immediate priority B — apply product-owner follow-ups

The decisions are already canonicalized in specs and posted on the PRs.

### PR #65
- OFF allows only an **explicit authorized human-requested** draft;
- manual-assist draft never auto-schedules/sends;
- encode trigger/source so background jobs cannot impersonate human intent;
- tenant/BP persona comes from resolved StyleProfile, not worker env.

### PR #66
- add minimal internal/dev/test Knowledge + Style seeding for Phase-2 E2E;
- no semantic inference of override conflicts;
- explicit override/supersession metadata only;
- StyleExample optional BCP-47-compatible language/locale;
- embeddings unavailable -> lexical-only degraded mode, no worker outage.

### PR #67
- Instagram STANDARD_ONLY + closed window -> SKIP routine automation;
- quiet hours defer only if provider eligibility remains valid;
- otherwise safe HOLD/terminal result, never late blind send;
- after-window policy input becomes channel-discriminated now;
- OFF manual-assist never enters automatic scheduling.

Apply in stack order and propagate normally.

## Next implementation task — #13 P2-06 Delivery Coordinator

Start after/while completing the focused owner follow-ups above, preserving dependency safety.

Required owner decisions already recorded:
- provider timing beats generic human-like delay;
- Instagram current verified automated budget = 30s; operational dispatch target ~25s;
- debounce + generation + artificial delay share the same budget;
- shorten/remove artificial delay as needed;
- missed provider deadline -> do not ordinary-AUTOPILOT send late;
- Human Agent remains explicit-human only;
- quiet-hours defer only if a compliant future send still exists;
- OFF manual-assist draft is never auto-scheduled;
- STANDARD_ONLY closed window is SKIP;
- consume channel-discriminated policy input.

Then continue:
#14 -> #15 -> #16, then #56 reliability.

## GitHub Actions / CI

Issue #37 / PR #62 has an active workflow at `.github/workflows/verify.yml` on the CI branch.

It runs root verify plus pgvector/PostgreSQL 17, migration drift, DB, Redis and E2E suites.

Do not call this exact-SHA evidence for another PR unless it actually ran against that code/ref. Integrate/propagate the workflow into the active stack dependency-safely before using it as release evidence.

## Independent-review protocol

Claude may continue dependency-safe implementation while Astra review lags, but:
- never claim Astra PASS without exact-head verdict;
- no self-merge of feature PRs to main;
- use full exact SHA markers;
- parent corrections propagate through children with normal merges;
- do not rebase/force-push published stack branches merely to clean history;
- Commercial Beta requires review catch-up.

## Master build train

1. **Stage B now:** #13 -> #14 -> #15 -> #16.
2. **Stage C:** #56 reliability / kill switches / reconciliation.
3. **Stage D:** #27 -> #58 -> #28 -> #29 -> #31 -> #32 -> #30 -> #33 -> #54 -> #55 -> #34 -> #35.
4. **Stage E:** #18 -> #19 -> #20 -> #21 -> #22 -> #23 -> #24.
5. **Stage F:** #57 privacy/security/deletion.
6. **Stage G:** commercial billing issues per #61 and accepted pricing specs.
7. **Stage H:** #59 Admin Operations.
8. **Stage I:** #60 Launch Readiness / Commercial Beta.

Independent review queues remain release-critical even when asynchronous.

## Per-task protocol

For every task:
1. fetch live parent/base and exact HEAD;
2. read `PROJECT_CONTEXT.md`, current handoff, `AGENTS.md`, `CLAUDE.md`;
3. read exact issue/task contract + relevant specs/ADRs;
4. implement only bounded scope;
5. test success/failure + tenant/BP + stale/race/idempotency as applicable;
6. run affected DB/Redis/E2E plus root verify;
7. adversarial/mutation-check critical invariants;
8. open/update narrow PR against correct parent;
9. publish exact `CLAUDE_READY_FOR_ASTRA`;
10. continue dependency-safe work without falsifying review status.

## Hard invariants

- Workspace + Business Profile isolation.
- Human activity wins over AI.
- Stale draft/review/action protection.
- Model proposes; deterministic application policy authorizes.
- No blind retry after ambiguous external write.
- Provider/webhook/job idempotency.
- Inbound persists when AI/retrieval/billing is blocked.
- AUTOPILOT is server-side.
- Queue is not sole durable intent store.
- Secrets never enter prompts/client output/normal logs/plaintext audit.
- Style never establishes factual authority.
- Provider policy/timing beats aesthetic delay.
