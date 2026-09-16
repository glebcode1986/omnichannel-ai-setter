# Task Contract — P4-03 Claude

**Issue:** #20 `[P4-03] Implement WhatsApp template catalog and outside-window policy`  
**Branch:** `feat/p4-03-whatsapp-templates-policy`  
**Owner:** Claude. Do not merge own PR.

## Start condition
#18/#19 contracts are stable. ADR-016 is Accepted; implement all three accepted WhatsApp after-window modes.

## Read first
`PROJECT_CONTEXT.md`, `WHATSAPP_ADAPTER.md`, `PHASE4_WHATSAPP_IMPLEMENTATION_PLAN.md`, ADR-016, `META_WHATSAPP_PHASE4_VERIFICATION.md`, Issue #20.

## Objective
Implement provider template sync/validation and shared policy plumbing for WhatsApp `TEMPLATE_ONLY` state without inventing free-form outside-window messaging.

## Required behavior
- sync template ID/name/language/category/components/status/version/sync metadata;
- only current eligible approved templates may send;
- runtime validate parameters against template structure;
- implement `SERVICE_WINDOW_ONLY | TEMPLATE_REVIEW | TEMPLATE_AUTOPILOT`;
- workspace/account without an explicit stored mode behaves as `SERVICE_WINDOW_ONLY` until configured;
- `TEMPLATE_REVIEW` requires an authorized human approval before outside-window send;
- `TEMPLATE_AUTOPILOT` requires an explicit template/use-case automation allowlist and deterministic policy approval;
- empty autopilot allowlist means no unattended outside-window template send;
- LLM may suggest/rank an eligible template but cannot rewrite approved template text arbitrarily or bypass consent/policy;
- final send revalidates current template status/language/parameters/consent/account health;
- final send audit records mode, template/version/language, variables, selection reason and human/system authorization.

## Tests
Approved/rejected/stale template, language mismatch, invalid/missing params, no eligible template, service-window open/template-only, all three policy modes, unset-mode conservative behavior, empty/non-empty autopilot allowlist, stop/unsubscribe override and template status changing during delay.

## PR
State that ADR-016 is Accepted and demonstrate all three modes. Re-verify implementation-time Meta policy/template rules. Run root/integration tests. Do not merge own PR.
