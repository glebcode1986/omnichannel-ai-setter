# Task Contract — P5-03 Claude

**Issue:** #29 `[P5-03] Build conversation operations and Review Queue`  
**Branch:** `feat/p5-03-review-conversation-ops`  
**Owner:** Claude. Do not merge own PR.

## Start condition
Shared Phase 2 policy, delivery and human-handoff APIs are accepted and Inbox shell is stable enough to integrate.

## Read first
`PROJECT_CONTEXT.md`, `PRODUCT_UX.md`, `AI_CONFIGURATION_UX.md`, `HUMAN_HANDOFF.md`, `DELIVERY_COORDINATOR.md`, Issue #29.

## Objective
Expose safe human reply/takeover and review workflows without duplicating backend policy.

## Required scope
- composer through shared server send path;
- effective OFF/DRAFT/AUTOPILOT display;
- pending delivery display/cancel;
- takeover/pause/resume;
- Review queue with reason/provenance/policy state;
- approve, edit+send, reject/dismiss, take-over actions;
- distinct Instagram human-assisted and WhatsApp template-review UI;
- clear stale-action recovery.

## Hard invariants
- no bulk customer-send approval;
- UI cannot override closed window, takeover or stale draft checks;
- approve/edit/send endpoints remain idempotent and server-revalidated;
- optimistic UI must not display provider delivery success prematurely.

## Verification
Test stale review, newer inbound, human race, window expiry, double click, cancel during delay, authorization, keyboard/mobile flow. Run root checks and open PR; do not merge.