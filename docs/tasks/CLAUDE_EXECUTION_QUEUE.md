# Claude Execution Queue

> Read `docs/handoff/CURRENT_HANDOFF.md` first. It is the current-stage ledger.
> GitHub issues/specs are authoritative; chat is not.

## Current state — 2026-09-19

Stage B implementation is complete through PR #71, but independent review catch-up is blocked at **PR #51**.

### Review state
- #49 P1-02 — Astra PASS
- #50 P1-03 — Astra PASS at `3934d99e391337498e7446b8335b90a3f6518b2d`
- #51 P1-04 — **Astra CHANGES_REQUESTED** at `3213497192f96ce15ac92767f855be4b9791d279`
- downstream #52 -> #71 remain queued until #51 passes

## NEXT TASK — fix PR #51

Astra found that `scheduleDelivery` silently clamps future delays above `MAX_SCHEDULE_DELAY_MS`, so a delivery declared for 30 days may execute after 7 days.

Required fix:
- derive delay from `scheduledFor`;
- reject future delay > `MAX_SCHEDULE_DELAY_MS`;
- never clamp/rewrite it earlier;
- write no BullMQ job on rejection;
- preserve immediate/past semantics explicitly;
- pin schedule/audit metadata consistency;
- add real Redis regression tests for max, max+1, far future, now/past and contradictory metadata.

Directive is posted on PR #51.

Publish:
`CLAUDE_READY_FOR_ASTRA head=<new-full-sha> task=P1-04`

Then propagate with normal merges through:
#52 -> #63 -> #64 -> #65 -> #66 -> #67 -> #68 -> #69 -> #70 -> #71.

No rebase/force-push and no merge to main.

## Astra protocol

After a new #51 HEAD exists:
1. re-review #51 only;
2. if PASS, continue dependency order through downstream PRs;
3. exact-head verdicts only;
4. do not re-review #50 unless its code changes — it already has PASS.

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

Stage B is implemented but not independently accepted downstream yet.

## Next new feature after review-safe propagation

Stage C — Issue #56:
- reliability;
- health;
- backpressure;
- kill switches;
- reconciliation consumer;
- safe recovery.

Then Design Partner UI, then WhatsApp, privacy, billing, Admin Operations and Launch Readiness per Master Issue #61.

## Hard invariants

- Workspace + Business Profile isolation
- human activity wins over AI
- no stale send
- no blind retry after ambiguity
- no delivery earlier than declared durable schedule
- exact provider/window/timing revalidation
- queues are execution mechanisms, not sole intent
- model output is advisory
- secrets never enter prompts/normal logs/client output/plaintext audit
