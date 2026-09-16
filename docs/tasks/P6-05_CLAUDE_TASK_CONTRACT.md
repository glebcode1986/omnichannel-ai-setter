# Task Contract — P6-05 Claude

**Issue:** #42 `[P6-05] Build billing, plan and usage settings UI`  
**Branch:** `feat/p6-05-billing-ui`  
**Owner:** Claude. Do not merge own PR.

## Start condition
#38/#39 APIs are stable. Provider checkout/portal actions may be wired after #41.

## Read first
`BILLING_ENTITLEMENTS.md`, `USAGE_METERING.md`, `PRICING_PACKAGING.md`, Phase 5 UX specs, Issue #42.

## Objective
Expose billing/plan/quota state clearly while keeping server state authoritative.

## Required behavior
- current plan/version/trial/subscription/grace state;
- usage included/used/remaining/reset date and warning/exhausted state;
- seat/channel limits;
- upgrade/downgrade/checkout/portal actions when available;
- explicit downgrade/cancel consequences;
- OWNER-only billing mutations;
- after provider return, refresh authoritative server state rather than assuming payment success.

## Tests
Role/workspace isolation, stale browser state, quota warning/exhaustion, over-capacity downgrade, trial expiry, checkout return before webhook, loading/error states and no secret/provider-sensitive rendering.

## PR
Use accessible responsive patterns and existing app shell. Do not encode entitlement truth client-side. Run root/E2E checks. Do not merge.