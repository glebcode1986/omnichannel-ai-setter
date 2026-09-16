# Product Requirements (PRD) — v0.2

## Problem

Small businesses/creators receive leads across messaging channels. Existing automation often replies instantly, feels robotic, fragments inboxes, loses context or lacks safe human handoff.

## Product promise

Connect Instagram and WhatsApp, teach the system business facts and the owner's communication style, and let an AI setter handle routine inbound conversations naturally while handing risky/high-value situations to a human.

## MVP users

- solo business owner / creator;
- small sales/service team;
- agency multi-workspace maturity later.

## MVP outcomes

Users can connect Instagram professional messaging and a WhatsApp Business Cloud API number; configure business identity/offer/goals/booking; manage factual knowledge and style examples; choose OFF/DRAFT/AUTOPILOT globally or per thread; see both channels in one inbox; use delayed natural replies; take over manually; review held drafts/reasons; track lead stage/handoff; support text and later voice-note transcription.

## Out of scope initially

- unsolicited cold-message blasting;
- scraping followers/contacts;
- unofficial WhatsApp Web transport;
- autonomous payments;
- autonomous high-risk legal/medical/financial advice;
- complex enterprise RBAC;
- channels beyond Instagram + WhatsApp.

## Functional requirements

### Messaging

Webhook ingestion, signature/auth verification, deduplication, conversation history, outbound send, delivery/read status when available, media metadata and platform raw metadata with retention controls.

### AI

Channel-neutral context, recent history, business knowledge retrieval, style retrieval, structured model output, confidence threshold, deterministic post-model gates and audit trail.

### Natural timing

Multi-message debounce, configurable randomized send delay, stale/human-takeover revalidation and optional read/typing signals where supported.

### Human control

Takeover/pause/resume, approve/edit/dismiss drafts, visible hold reasons and channel-aware send constraints.

### Compliance

Respect current channel messaging windows/capabilities. WhatsApp out-of-window sends use approved templates where policy requires. Tokens/credentials isolated per workspace/account.

## Non-functional requirements

Durable jobs, idempotent ingestion/delivery, full observability, horizontal worker scalability, encrypted secrets and tests for policy-critical flows.
