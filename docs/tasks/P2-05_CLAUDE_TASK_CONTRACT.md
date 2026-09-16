# Task Contract — P2-05 Claude

**Issue:** #12 `[P2-05] Implement deterministic policy engine`  
**Branch:** `feat/p2-05-policy-engine`  
**Depends on:** #10 AI engine and #11 retrieval, plus Phase 1 account/mode/window/handoff primitives.  
**Owner:** Claude. Do not merge own PR.

## Read first
`PROJECT_CONTEXT.md`, `POLICY_ENGINE.md`, `AI_BEHAVIOR.md`, ADR-004/014, `CHANNEL_CONTRACTS.md`, Issue #12.

## Objective
Implement a pure deterministic policy evaluator. It receives current state + validated AI draft and returns a policy action; it does not call Meta, queues or the LLM.

## Required output
Use an explicit decision union such as `SKIP | HOLD_REVIEW | SCHEDULE` with normalized reason codes and any required review mode/window metadata.

## Gates
Evaluate at least:
- OFF/DRAFT/AUTOPILOT mode;
- validated model output/confidence;
- mandatory-review categories;
- factual support/provenance;
- account health/capabilities;
- human takeover state;
- current channel window;
- quiet-hours/timing policy;
- content capability;
- current reply-cycle ownership/freshness.

## Instagram after-window rule
- `STANDARD_ONLY`: closed standard automated window cannot schedule an AI send.
- `HUMAN_ASSISTED_EXTENDED`: when current Human Agent eligibility/approval exists, return a deliberate human-review path, never an unattended `HUMAN_AGENT` schedule.
- Human Agent unavailable/expired -> hold/skip according to spec, never fabricate eligibility.

## Tests
Table-driven tests independently fail every gate and cover interactions: low confidence, missing fact, DRAFT/OFF, takeover, quiet hours, unsupported media, stale reply cycle, account disconnected, standard-window closed under both policies, Human Agent eligible/unavailable/expired.

## PR requirements
Policy package must remain pure/deterministic with no provider SDK, Prisma query, network call or queue side effect. Run root tests and include decision matrix summary. Do not merge.
