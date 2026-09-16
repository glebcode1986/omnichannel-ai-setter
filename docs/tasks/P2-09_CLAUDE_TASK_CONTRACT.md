# Task Contract — P2-09 Claude

**Issue:** #16 `[P2-09] Complete Instagram AI vertical slice end to end`  
**Branch:** `feat/p2-09-instagram-ai-vertical-slice`  
**Depends on:** #8–#15 accepted.  
**Owner:** Claude. Do not merge own PR.

## Read first
`PROJECT_CONTEXT.md`, `CURRENT_HANDOFF.md`, all Phase 2 specs/ADRs, `PHASE2_IMPLEMENTATION_PLAN.md`, Issue #16.

## Objective
Wire the completed components into one real Instagram text-conversation path without creating alternate shortcuts around shared policy, handoff or delivery orchestration.

## Required end-to-end flow
Instagram inbound webhook -> verification/normalization -> idempotent persistence -> debounce -> factual/style retrieval -> AI draft -> deterministic policy -> DRAFT hold or AUTOPILOT durable human-like delay -> final revalidation -> delivery coordinator -> Instagram adapter send -> echo/status persistence/reconciliation -> human takeover when appropriate.

## Required scenarios
- normal AUTOPILOT text reply;
- DRAFT review/approval;
- newer inbound supersedes draft/pending delivery;
- native/manual human reply pauses AI;
- own API echo does not falsely pause;
- low confidence and missing fact -> review;
- unsupported/high-risk input -> safe review path;
- `STANDARD_ONLY` closed standard window;
- `HUMAN_ASSISTED_EXTENDED` closed standard window -> human review/send only when current Human Agent eligibility permits;
- Human Agent eligibility expires before approval;
- provider rejection vs ambiguous network outcome;
- duplicate webhook/job and worker race cannot double-send.

## Integration requirements
Use fixture/fake Meta/provider for automated end-to-end tests; no production credential required in CI. Also provide a documented sandbox/manual test plan for a Meta test/professional account.

## Architecture guard
No route, UI action or worker may bypass the shared policy engine and delivery coordinator for AI or reviewed-draft sends. Any unavoidable deviation requires an ADR before implementation.

## PR requirements
Include sequence diagram/current component wiring, all integration scenarios and exact test commands. Run root checks/evals. Do not merge until R2 review is complete.
