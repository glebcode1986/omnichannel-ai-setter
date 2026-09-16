# Task Contract — P6-07 Claude

**Issue:** #44 `[P6-07] Complete commercial SaaS billing and quota E2E slice`  
**Branch:** `feat/p6-07-commercial-e2e`  
**Owner:** Claude. Do not merge own PR.

## Start condition
#38–#43 sufficiently stable; provider-specific scenarios require #41.

## Read first
All Phase 6 specs/ADRs/contracts, Issue #44 and R6 review criteria.

## Objective
Validate the full commercial flow and adversarial quota/subscription transitions without real charges.

## Required scenarios
Trial/active entitlement, plan version change, usage reserve/generate/commit, duplicate retry no double charge, quota exhaustion with inbound persistence, entitlement loss during delayed send, downgrade over capacity, provider webhook transition/replay/reordering, usage reconciliation and two-workspace isolation.

## Acceptance criteria
- automated E2E/integration suite uses fixtures/provider test mode;
- no real card charges/secrets;
- server remains authoritative under stale clients;
- usage and plan decisions are auditable;
- no duplicate billing under retries/races;
- no customer data deletion on downgrade/cancel.

## PR
Include scenario matrix and exact commands/results. Resolve R6 blockers before merge. Do not merge own PR.