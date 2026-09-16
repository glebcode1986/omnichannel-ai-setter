# Task Contract — P6-06 Claude

**Issue:** #43 `[P6-06] Implement versioned Starter/Growth/Scale plan catalog`  
**Branch:** `feat/p6-06-plan-catalog`  
**Owner:** Claude. Do not merge own PR.

## Start condition
#38 model is stable and product owner has approved concrete prices/quotas/trial/overage choices for production values.

## Read first
`PRICING_PACKAGING.md`, `BILLING_ENTITLEMENTS.md`, ADR-017, Issue #43.

## Objective
Implement a versioned server-side plan catalog; pricing/limits are configuration, not scattered code branches.

## Required behavior
- stable plan key + immutable version;
- Starter/Growth/Scale display metadata;
- monthly/annual provider-price refs by selected currencies;
- feature flags, hard limits, usage grants and overage/trial policy refs;
- PUBLIC/PRIVATE/LEGACY availability;
- grandfathering;
- pricing/settings read from catalog data;
- no safety/platform compliance invariant is premium-gated.

## Tests
Version immutability/grandfathering, duplicate invalid version, visibility, monthly/annual variants, provider price mapping and proof feature code does not branch on display name/provider ID.

## PR
Document exact product-owner-approved values used. Do not invent prices/quotas if still undecided. Run root tests and do not merge.