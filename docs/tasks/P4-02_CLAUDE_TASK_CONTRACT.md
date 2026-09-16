# Task Contract — P4-02 Claude

**Issue:** #19 `[P4-02] Implement WhatsApp Embedded Signup and account lifecycle`  
**Branch:** `feat/p4-02-whatsapp-onboarding`  
**Owner:** Claude. Do not merge own PR.

## Read first
`PROJECT_CONTEXT.md`, `CURRENT_HANDOFF.md`, `WHATSAPP_ONBOARDING.md`, ADR-002/009/015, `DATA_MODEL.md`, `META_WHATSAPP_PHASE4_VERIFICATION.md`, Issue #19.

## Objective
Implement secure multi-tenant WhatsApp onboarding with Meta Embedded Signup and official Cloud API business/WABA/phone assets.

## Required behavior
- signed state/CSRF-bound connect/callback;
- workspace OWNER/authorized ADMIN only;
- validate current permissions and authorized provider assets;
- persist flexible business/WABA/phone-number IDs and encrypted credential references;
- phone registration/two-step verification where current Meta flow requires it;
- subscribe app to WABA webhooks;
- account/capability/quality health state;
- template bootstrap;
- reconnect/reauth/disconnect;
- coexistence captured only as provider-proven capability/onboarding mode;
- no secret/token leakage to logs, URLs, analytics or client payloads after exchange.

## Tests
Valid onboarding, state mismatch, missing scopes, partial failure, registration/subscription failure, callback replay, asset collision across workspaces, reconnect/disconnect, coexistence eligible/unavailable and secret-redaction checks.

## PR
Re-verify current Embedded Signup scopes, app-access requirements, registration deadlines and provider asset model. Update research/ADR if Meta changed. Do not merge.