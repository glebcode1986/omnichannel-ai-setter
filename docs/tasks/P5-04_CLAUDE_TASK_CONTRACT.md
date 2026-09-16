# Task Contract — P5-04 Claude

**Issue:** #30 `[P5-04] Build AI Settings and no-send simulation playground`  
**Branch:** `feat/p5-04-ai-settings-simulation`  
**Owner:** Claude. Do not merge own PR.

## Start condition
Phase 2 AI/policy/retrieval configuration APIs are accepted.

## Read first
`PROJECT_CONTEXT.md`, `AI_CONFIGURATION_UX.md`, `ONBOARDING_UX.md`, ADR-014, ADR-016, Issue #30.

## Objective
Create owner-friendly AI settings plus a no-send simulation that exposes model + deterministic-policy reasoning.

## Required scope
- mode, business goal, qualification/review settings;
- Conservative/Balanced/Aggressive presets;
- Fast/Natural/Custom timing;
- takeover/resume settings;
- Instagram after-window selector;
- WhatsApp `SERVICE_WINDOW_ONLY | TEMPLATE_REVIEW | TEMPLATE_AUTOPILOT` and allowlist UI;
- simulation showing factual/style hits, draft, confidence/reasons, lead suggestion and policy result;
- impact summary/confirmation for high-impact changes.

## Hard invariants
Simulation never sends. Frontend presets map to server-owned policy values. Provider/model SDK details do not leak into normal owner UX. No template autopilot without explicit mode + allowlist.

## Verification
Test authorization, persistence, preset mapping, high-impact confirmations, empty allowlist, simulation no-send, isolation and audit records. Run root checks; open PR; do not merge.