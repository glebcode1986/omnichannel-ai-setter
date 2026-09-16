# Task Contract — P4-06 Claude

**Issue:** #23 `[P4-06] Implement WhatsApp coexistence and native-human takeover`  
**Branch:** `feat/p4-06-whatsapp-coexistence-handoff`  
**Owner:** Claude. Do not merge own PR.

## Read first
`PROJECT_CONTEXT.md`, `WHATSAPP_ONBOARDING.md`, `WHATSAPP_ADAPTER.md`, `HUMAN_HANDOFF.md`, ADR-004/013/015, `META_WHATSAPP_PHASE4_VERIFICATION.md`, Issue #23.

## Objective
Support eligible WhatsApp Business App + Cloud API coexistence while ensuring a human using the native app always wins over automation.

## Required behavior
- coexistence is provider-confirmed capability, never assumed;
- correlate known app-originated outbound messages/statuses vs supported native/manual human signals;
- unmatched verified human/native activity -> shared `HUMAN_ACTIVE`, pending AI becomes stale;
- correlated own send must not trigger false takeover;
- explicit resume follows shared handoff rules;
- when provider cannot classify native authorship reliably, fail safe and expose limitation rather than guess.

## Tests
Eligible/unavailable coexistence, own echo/status, native human send, worker race, event reordering, reconnect/disconnect and unclassifiable-signal fail-safe.

## PR
Re-verify current Meta coexistence eligibility/event fields and cite the evidence. Do not merge.