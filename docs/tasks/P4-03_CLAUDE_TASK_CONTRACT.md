# Task Contract — P4-03 Claude

**Issue:** #20 `[P4-03] Implement WhatsApp template catalog and outside-window policy`  
**Branch:** `feat/p4-03-whatsapp-templates-policy`  
**Owner:** Claude. Do not merge own PR.

## Start condition
#18/#19 contracts are stable. Infrastructure/catalog work may begin while ADR-016 is Proposed; unattended outside-window auto-send behavior must wait for owner acceptance of ADR-016.

## Read first
`PROJECT_CONTEXT.md`, `WHATSAPP_ADAPTER.md`, `PHASE4_WHATSAPP_IMPLEMENTATION_PLAN.md`, ADR-016, `META_WHATSAPP_PHASE4_VERIFICATION.md`, Issue #20.

## Objective
Implement provider template sync/validation and shared policy plumbing for WhatsApp `TEMPLATE_ONLY` state without inventing free-form outside-window messaging.

## Required behavior
- sync template ID/name/language/category/components/status/version/sync metadata;
- only current eligible approved templates may send;
- runtime validate parameters against template structure;
- schema supports `SERVICE_WINDOW_ONLY | TEMPLATE_ASSISTED`;
- if ADR-016 remains Proposed, no default/auto-send behavior is invented;
- LLM may suggest/rank an eligible template but cannot rewrite approved template text arbitrarily;
- final send audit records template, variables, selection reason and human/system authorization.

## Tests
Approved/rejected/stale template, language mismatch, invalid/missing params, no eligible template, service-window open/template-only, stop/unsubscribe override and template status changing during delay.

## PR
Call out whether ADR-016 is Accepted. If not, keep outside-window automation gated. Run root/integration tests. Do not merge own PR.