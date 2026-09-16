# Phase 4 Implementation Plan — WhatsApp Cloud API Vertical Slice

**Status:** Architecture prepared. Implementation is sequenced after the shared core/AI/delivery/handoff layers are stable enough to reuse safely.

## Goal

Add WhatsApp as a first-class second channel using the same conversation/AI/policy/delivery/handoff core as Instagram, with official Cloud API transport and Embedded Signup onboarding.

Target vertical slice:

```text
WhatsApp customer message
  -> verified Cloud API webhook
  -> normalized shared conversation
  -> debounce
  -> optional media/voice processing
  -> shared factual/style retrieval
  -> shared AI draft
  -> shared deterministic policy
  -> human-like durable delay / review
  -> WhatsApp final window/template revalidation
  -> optional read/typing presence near send
  -> Cloud API send
  -> sent/delivered/read reconciliation
  -> native-human takeover/coexistence when supported
```

## Work packages

### P4-01 — WhatsApp Cloud API transport adapter

Implement `packages/channel-whatsapp` webhook verification/normalization, text transport, statuses, normalized window evaluation and provider outcome mapping.

### P4-02 — Embedded Signup onboarding + provider asset lifecycle

Implement secure workspace onboarding, WABA/phone-number identity, webhook subscription, registration, credential lifecycle, account health and capability metadata.

### P4-03 — Template catalog + outside-window policy

Sync approved templates/status/languages/components; implement `TEMPLATE_ONLY` policy plumbing and product-configurable outside-window behavior without allowing arbitrary free-form sends outside the service window.

**Blocked product decision:** ADR-016 remains Proposed until owner selects defaults/automation level.

### P4-04 — Media + voice notes

Normalize/fetch permitted media, support inbound voice-note transcription with provenance and fail-safe behavior. Reuse shared AI engine; raw media/transcript remains untrusted content.

### P4-05 — Read/typing presence timing

Use supported WhatsApp read receipt + typing indicator as best-effort presence near actual delivery. Do not replace durable human-delay scheduling and do not keep typing active mechanically throughout the full random delay.

### P4-06 — Coexistence/native human activity + takeover

Where current Meta account/onboarding capabilities support WhatsApp Business App coexistence, correlate app-originated sends and native human activity into the shared human-takeover model. Coexistence is capability-gated, not universally assumed.

### P4-07 — WhatsApp end-to-end vertical slice

Wire inbound text/voice -> AI/review/autopilot -> delayed Cloud API reply -> status/echo reconciliation with service-window/template policy and takeover behavior.

### R4 — independent Codex/Astra review

Adversarial review/test pass across signature verification, tenancy, token handling, template eligibility, media safety, window boundaries, duplicate sends, status reordering and coexistence races.

## Dependency graph

```text
stable shared core + AI/delivery/handoff
       |-----------------------|
       v                       v
   P4-01 transport         P4-02 onboarding
       |                       |
       +-----------+-----------+
                   v
              P4-03 templates/window
                /      \
               v        v
          P4-04 media   P4-05 presence
               \        /
                v      v
              P4-06 coexistence/handoff
                   |
                   v
              P4-07 vertical slice

R4 reviews incrementally across P4-01..P4-07.
```

P4-04 and P4-05 may proceed in parallel after the transport/account contracts are stable. P4-06 should not promise coexistence behavior until the implementation-time Meta capability is verified.

## Reuse rules

Do not duplicate core behavior already implemented for Instagram:

- contact/conversation storage;
- AI provider abstraction;
- knowledge/style retrieval;
- deterministic general safety gates;
- durable debounce/random delay;
- delivery atomic claim/ambiguity quarantine;
- review/human takeover state;
- evaluation harness.

WhatsApp packages own only provider-specific facts/capabilities/payloads. Shared policy can consume normalized `OPEN_FREEFORM` / `TEMPLATE_ONLY` and capability data.

## Phase 4 exit criteria

- eligible workspace can connect a WhatsApp business phone through current official onboarding/test flow;
- verified webhook ingests text and statuses idempotently;
- inbound text can reach the same AI draft/review/autopilot core used by Instagram;
- free-form send is blocked when current service window does not permit it;
- approved template route is represented correctly and follows the final ADR-016 product choice;
- read/typing presence is best-effort and never weakens delivery safety;
- inbound voice can be transcribed or safely escalated when transcription fails;
- manual/native WhatsApp Business App activity pauses automation where supported/detectable;
- duplicate webhook/job/reordered status/ambiguous send cannot create duplicate customer messages;
- fixture/integration tests run without production credentials and a sandbox/manual Meta test plan exists.
