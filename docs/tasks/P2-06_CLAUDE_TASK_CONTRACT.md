# Task Contract — P2-06 Claude

**Issue:** #13 `[P2-06] Implement delivery coordinator and final revalidation`  
**Branch:** `feat/p2-06-delivery-coordinator`  
**Depends on:** #5 queue primitives, #8 Instagram adapter, #12 policy engine.  
**Owner:** Claude. Do not merge own PR.

## Read first
`PROJECT_CONTEXT.md`, `DELIVERY_COORDINATOR.md`, `DELAY_ENGINE.md`, ADR-003/012/013/014, `CHANNEL_CONTRACTS.md`, Issue #13.

## Objective
Create the single outbound delivery coordinator used by AUTOPILOT and human-approved drafts. No other path may send AI/customer replies directly through a channel adapter.

## Required behavior
- choose/persist natural delay and schedule using configured timing policy (initial target 30–120s);
- immediately before send re-evaluate reply-cycle ownership, newer inbound, human takeover, mode, draft status, account health, channel window/policy and idempotency;
- atomically claim the logical delivery;
- use stable operation IDs/correlation IDs;
- map `ACCEPTED`, definite `REJECTED` and `AMBIGUOUS` correctly;
- retry only explicitly retryable definite failures;
- quarantine ambiguous/network-midflight results with no blind resend;
- recover stale `SENDING` after process restart into a safe reconciliation/hold state;
- newer inbound, manual human activity or changed policy cancels/stales pending delivery.

## Human Agent boundary
Automated delayed-delivery jobs must not silently add `HUMAN_AGENT`. An explicitly human-approved extended-window action may enter this coordinator carrying audited human actor/action context and must still revalidate eligibility immediately before send.

## Tests
Two workers racing one delivery, duplicate jobs, retryable rejection, non-retryable rejection, timeout ambiguity, stale claim/restart, newer-message supersession, human takeover during delay, policy/window change during delay and human-assisted extended-window eligibility expiry.

## PR requirements
Document atomic claim transaction/constraint strategy and ambiguous-outcome recovery. Run concurrency/integration/root tests. Do not merge.
