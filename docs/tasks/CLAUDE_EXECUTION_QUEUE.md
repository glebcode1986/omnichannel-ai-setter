# Claude Execution Queue

> Read `docs/handoff/CURRENT_HANDOFF.md` first. It is the current-stage ledger.
> GitHub issues/specs are authoritative; chat is not.

## Current state — 2026-09-20

Stage B is implemented through PR #71.
Stage C reliability is implemented in PR #72.

Independent review has advanced past #51 and is now blocked at **PR #52**.

### Review state
- #49 P1-02 — Astra PASS
- #50 P1-03 — Astra PASS at `3934d99e391337498e7446b8335b90a3f6518b2d`
- #51 P1-04 — Astra PASS at `1fb13b1aef0dd8dac5d905a4af7169f9735a7ef6`
- #52 P1-05 — **Astra CHANGES_REQUESTED** at `193ef5ce5950977cd3116bbda6dc3d8aa838ecfe`
- downstream #63 -> #72 remain queued

## NEXT TASK — fix PR #52 before opening Stage D

Astra found a security/logging bug:

`VerificationResult.REJECTED.reason` is adapter-controlled free text, and `ingestWebhook` copies it into structured logs. Because adapters can inspect raw webhook headers/query/body, this can leak credentials or customer/provider payload fragments.

Required fix:
- never log adapter free-form verification reason;
- use only application-owned closed reason codes;
- add a canary test proving returned secret/body/header/query fragments never reach any logged field;
- preserve unauthorized/challenge/verify-before-normalize semantics;
- search only the same ingestion/outbox path for sibling free-form adapter/provider log leaks.

Publish:
`CLAUDE_READY_FOR_ASTRA head=<new-full-sha> task=P1-05`

Then propagate with normal merges through:
#63 -> #64 -> #65 -> #66 -> #67 -> #68 -> #69 -> #70 -> #71 -> #72.

Do not rebase/force-push. Do not merge to main.

## Astra protocol

After the new #52 HEAD:
1. re-review #52 only;
2. if PASS, continue dependency order through #72;
3. exact-head verdicts only;
4. do not re-review #50/#51 unless accepted code changed.

## Stage B implemented

- #63 Instagram adapter
- #64 Instagram onboarding/tokens
- #65 AI draft engine
- #66 Knowledge/Style retrieval
- #67 deterministic policy
- #68 delivery coordinator
- #69 human handoff/review
- #70 eval harness/goldens
- #71 Instagram E2E slice

## Stage C implemented

PR #72 / Issue #56:
- health;
- scoped kill switches;
- backpressure;
- durable reconciliation;
- safe recovery;
- incident state/metrics.

### Owner decision for ADR-017
Do not attribute unmatched outbound echoes to ambiguous automated sends in MVP.

Unmatched echo remains human/native activity and triggers takeover.
Ambiguous sends remain quarantined/reconciled unless authoritative correlation exists.
Human-takeover safety wins over reducing false-positive Review work.

## STOP CONDITION BEFORE STAGE D

Do **not** open new Stage D UI implementation PRs until:
- #52 has a corrected HEAD;
- that correction is propagated through #72;
- Astra has resumed dependency-order review from #52.

This prevents the known queue scheduling defect from being copied into an even wider stack.

## Next new feature train after the stop condition

Stage D — Design Partner UI:
#27 -> #58 -> #28 -> #29 -> #31 -> #32 -> #30 -> #33 -> #54 -> #55 -> #34 -> #35.

Then:
- Stage E WhatsApp;
- Stage F privacy/security;
- Stage G billing;
- Stage H Admin Operations;
- Stage I Launch Readiness.

## Hard invariants

- Workspace + Business Profile isolation
- human activity wins over AI
- no stale send
- no blind retry after ambiguity
- no delivery earlier than declared schedule
- exact provider/window/timing revalidation
- queues are execution mechanisms, not sole intent
- model output is advisory
- secrets never enter prompts/normal logs/client output/plaintext audit
