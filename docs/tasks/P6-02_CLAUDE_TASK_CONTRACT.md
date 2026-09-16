# Task Contract — P6-02 Claude

**Issue:** #39 `[P6-02] Implement idempotent usage ledger and quota reservation`  
**Branch:** `feat/p6-02-usage-ledger`  
**Owner:** Claude. Do not merge own PR.

## Start condition
#38 entitlement model and DB transaction primitives are stable.

## Read first
`USAGE_METERING.md`, `BILLING_ENTITLEMENTS.md`, ADR-018, Issue #39.

## Objective
Implement append-oriented logical-operation usage metering with atomic hard-quota reservation.

## Required behavior
- `AI_GENERATION_CYCLES` metric;
- stable usage operation IDs;
- usage-cycle boundaries;
- reserve/commit/release state transitions;
- uniqueness/idempotency under duplicate workers/retries;
- materialized totals reconstructable from ledger;
- provider token/cost telemetry separate from billable usage;
- reconciliation adjustments are audited, not destructive.

## Tests
Last-unit concurrency race, duplicate job/restart, repair/provider retry no double charge, reservation release, cycle boundary, workspace isolation and counter-vs-ledger reconciliation.

## PR
Explain transaction/locking strategy and charging-policy assumptions. Run concurrency/integration tests and root checks. Do not merge.