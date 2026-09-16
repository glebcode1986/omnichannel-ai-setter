# Task Contract — P6-04 Claude

**Issue:** #41 `[P6-04] Implement billing provider adapter and verified webhook lifecycle`  
**Branch:** `feat/p6-04-billing-provider`  
**Owner:** Claude. Do not merge own PR.

## Start condition
#38 entitlement model is stable **and** product owner has selected the billing provider / merchant-jurisdiction strategy.

## Read first
`BILLING_ENTITLEMENTS.md`, ADR-017, `PHASE6_COMMERCIALIZATION_PLAN.md`, Issue #41, and implementation-time provider docs.

## Objective
Implement one concrete billing provider behind the provider-neutral application port.

## Required behavior
- checkout + customer-portal integration where supported;
- raw webhook verification fails closed;
- deterministic normalized billing events;
- duplicate/reordered/replayed events are idempotent;
- secure opaque provider references;
- no raw card/payment data in our DB/logs;
- reconciliation path for missed/provider-divergent state;
- provider SDK/types remain private to adapter/infrastructure.

## Forbidden
Do not choose a provider implicitly. Do not let provider status/price IDs become application/domain enums or feature checks.

## Tests
Valid/invalid signature, duplicate/reordered webhook, workspace/provider-ID isolation, checkout failure, API timeout, cancel/end-period transitions and reconciliation using provider test mode/fixtures only.

## PR
Cite current provider docs/API version used. Run root/integration/security tests. No real charges. Do not merge.