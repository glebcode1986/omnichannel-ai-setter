# Task Contract — P6-01 Claude

**Issue:** #38 `[P6-01] Implement plan, subscription and entitlement domain`  
**Branch:** `feat/p6-01-entitlements`  
**Owner:** Claude. Do not merge own PR.

## Start condition
Phase 1 domain/application/DB foundations are stable.

## Read first
`PROJECT_CONTEXT.md`, `BILLING_ENTITLEMENTS.md`, `PRICING_PACKAGING.md`, ADR-017, `PHASE6_COMMERCIALIZATION_PLAN.md`, Issue #38.

## Objective
Implement provider-neutral versioned plan/subscription/entitlement primitives and persistence. No payment provider SDK/API in this task.

## Required behavior
- immutable plan versions;
- normalized subscription states;
- effective entitlement snapshot from plan/trial/grace/overrides;
- feature, hard-limit and usage-grant representations;
- workspace scoping and OWNER-only mutations;
- opaque provider references only in infrastructure persistence fields;
- audit transitions and overrides;
- downgrade/cancel never deletes data.

## Tests
Workspace isolation, immutable/grandfathered versions, normalized states, override precedence/expiry, role authorization, downgrade behavior and no provider-specific types in domain/application.

## PR
Run root/integration checks; document schema/transaction decisions. Do not integrate Stripe/Paddle/other provider and do not merge.