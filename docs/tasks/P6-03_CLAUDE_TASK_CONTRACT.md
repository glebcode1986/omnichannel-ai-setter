# Task Contract — P6-03 Claude

**Issue:** #40 `[P6-03] Enforce entitlements across AI, channels and delayed delivery`  
**Branch:** `feat/p6-03-entitlement-enforcement`  
**Owner:** Claude. Do not merge own PR.

## Start condition
#38/#39 plus relevant AI/delivery/channel use cases are stable.

## Read first
`BILLING_ENTITLEMENTS.md`, `USAGE_METERING.md`, ADR-017/018, delivery/policy specs, Issue #40.

## Objective
Make paid-feature/quota enforcement server authoritative without losing inbound customer data.

## Required behavior
- check/reserve before AI generation;
- channel/member/transcription capacity checks;
- delayed automated send revalidates current entitlement immediately before send;
- normalized `BILLING_LIMIT` outcome;
- inbound webhook/message persistence continues when AI is blocked;
- billing gate does not override safety, policy or human takeover;
- client-visible entitlement state is never trusted as authorization.

## Tests
Quota exhausted, concurrent last-unit reservation, subscription/plan change during delay, downgrade during active conversation, inbound while blocked, stale client bypass attempt and manual handling path.

## PR
Document enforcement order relative to policy/handoff/delivery gates. Run root/concurrency/integration tests. Do not merge.