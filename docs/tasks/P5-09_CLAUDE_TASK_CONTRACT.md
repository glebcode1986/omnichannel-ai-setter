# Task Contract — P5-09 Claude

**Issue:** #35 `[P5-09] Complete SaaS UX end-to-end, responsive and accessibility pass`  
**Branch:** `feat/p5-09-product-ux-e2e`  
**Owner:** Claude. Do not merge own PR.

## Start condition
P5-01 through P5-08 are sufficiently stable and integrated.

## Read first
All Phase 5 UX specs, `PHASE5_IMPLEMENTATION_PLAN.md`, relevant P5 contracts/issues, Issue #35.

## Objective
Prove the end-to-end operator journey and harden responsive/accessibility/error-state behavior.

## Required scope
- onboarding resume through activation;
- inbox/search/filter/conversation/manual reply/takeover;
- DRAFT review approve/edit/reject;
- AUTOPILOT pending delay/cancel;
- missing-fact -> confirmed knowledge workflow;
- lead transition from inbox/pipeline;
- policy-change audit;
- mobile stacked workflow;
- keyboard-only critical workflows;
- loading/empty/error/stale/network-recovery states.

## Hard invariants
Use fixture/test-double backends, not production Meta credentials. E2E must exercise server authorization and stale-state behavior, not only happy-path DOM interactions.

## Verification
Run E2E suite plus accessibility/focus/keyboard/responsive checks and root lint/typecheck/test/build. Document tested viewport ranges and remaining limitations. Open PR; do not merge.