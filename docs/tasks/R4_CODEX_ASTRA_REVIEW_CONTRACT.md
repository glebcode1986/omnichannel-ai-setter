# Review Contract — R4 Codex/Astra

**Issue:** #25 `[R4] Codex/Astra independent WhatsApp safety and architecture review`  
**Executor:** Codex/Astra as independent reviewer/test author.

## Required review targets
- webhook authenticity verification uses raw body and fails closed;
- provider WABA/phone-number identity cannot cross tenants;
- Embedded Signup state/permissions/tokens and secret redaction;
- production transport is official Cloud API only;
- free-form service-window enforcement and approved-template path outside it;
- ADR-016 owner-selected template automation level is respected;
- template status/language/parameter validation and stop/unsubscribe override;
- media download/transcription bounds and prompt-injection treatment;
- typing/read presence cannot bypass/couple incorrectly to delivery;
- final pre-send revalidation, atomic claim and ambiguity quarantine;
- duplicate/replayed webhook and reordered sent/delivered/read statuses;
- coexistence/native-human takeover and worker races;
- credential/PII logging minimization.

## Independent tests
Prioritize forged signature, webhook replay, same phone asset across workspaces, token expiry mid-send, template status changing during delay, stop/unsubscribe race, malicious voice transcript, reordered statuses, native human reply racing delivery claim, and network timeout after provider request may have been accepted.

## Output
For each PR: `PASS` or `CHANGES_REQUESTED` with exact evidence/test. Systemic gaps require ADR/spec changes, not silent workarounds.

## Merge rule
P4-07 must not merge with unresolved findings involving platform policy, tenancy, credentials, duplicate sends, ambiguity or human takeover.