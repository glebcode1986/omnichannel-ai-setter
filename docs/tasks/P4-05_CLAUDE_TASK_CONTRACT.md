# Task Contract — P4-05 Claude

**Issue:** #22 `[P4-05] Implement WhatsApp read and typing presence timing`  
**Branch:** `feat/p4-05-whatsapp-presence`  
**Owner:** Claude. Do not merge own PR.

## Read first
`PROJECT_CONTEXT.md`, `WHATSAPP_ADAPTER.md`, `DELAY_ENGINE.md`, `DELIVERY_COORDINATOR.md`, Issue #22.

## Objective
Use official read receipt + typing indicator to make WhatsApp replies feel natural without replacing durable 30–120s scheduling or weakening cancellation/revalidation.

## Required behavior
- presence is application timing/UX, not reply ownership;
- optional read receipt at configured point;
- typing occurs near actual send, not mechanically for entire delay;
- newer inbound, takeover or cancelled delivery stales pending presence;
- presence failure is best-effort and never causes duplicate send/retry;
- no sleep in webhook/request lifecycle.

## Tests
Normal delayed send, cancelled/stale send, newer inbound, human takeover, provider presence error, duplicate presence job and review-only draft.

## PR
Document timing defaults/configuration. Run root tests. Do not merge.