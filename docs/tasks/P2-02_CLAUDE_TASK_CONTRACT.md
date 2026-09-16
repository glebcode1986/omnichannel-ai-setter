# Task Contract — P2-02 Claude

**Issue:** #9 `[P2-02] Implement Instagram Login onboarding and token lifecycle`  
**Branch:** `feat/p2-02-instagram-onboarding`  
**Start condition:** Phase 1 exit; coordinate with accepted P2-01 contracts.  
**Owner:** Claude. Do not merge own PR.

## Read first
`PROJECT_CONTEXT.md`, `CURRENT_HANDOFF.md`, ADR-006/009/014, `INSTAGRAM_ADAPTER.md`, `DATA_MODEL.md`, `META_INSTAGRAM_PHASE2_VERIFICATION.md`, Issue #9.

## Objective
Implement secure professional-account onboarding through Instagram Login without introducing an unnecessary Facebook Page dependency unless current Meta requirements force a documented architecture change.

## Required behavior
- connect/OAuth/callback flow with state/CSRF protection;
- request the current required professional-account scopes including messaging;
- validate connected professional account identity and connection state;
- persist token material only through the accepted encrypted credential/reference design;
- refresh/expiry/reauth/disconnect handling;
- capability snapshot including known Human Agent approval state when discoverable;
- multi-workspace isolation;
- no secrets in logs, browser-visible persistent URLs, error payloads or analytics.

## Tests
State mismatch/CSRF, callback denial/error, missing scopes, expired token, reconnect, disconnect, wrong workspace, duplicate callback/retry and capability refresh.

## PR requirements
Document the exact current Meta scopes/endpoints/token lifecycle verified during implementation. If Meta requirements changed, update `META_INSTAGRAM_PHASE2_VERIFICATION.md` and ADR/spec before normalizing the change in code. Run root checks and relevant integration tests. Do not merge.
