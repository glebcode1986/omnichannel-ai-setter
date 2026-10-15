# WhatsApp Adapter — Phase 4 Specification

**Status:** Transport implemented in `packages/channel-whatsapp` (P4-01 / Issue #18, 2026-10-04). Platform
facts re-verified the same day; see the re-verification section of
`docs/research/META_WHATSAPP_PHASE4_VERIFICATION.md`.

What P4-01 covers: raw-body verification, inbound normalization, the four window states, free-form text and
approved-template sending, and the read/typing presence effect. What it does not: Embedded Signup (#19), the
template catalogue and outside-window policy (#20), outbound media and voice processing (#21), presence
timing policy (#22), coexistence onboarding (#23) and the vertical slice (#24). The adapter reports
`interactive: false` until #20 turns it on.

## Purpose

Implement `packages/channel-whatsapp` as an official WhatsApp Cloud API adapter behind the shared `ChannelAdapter` boundary. WhatsApp-specific policy, message/template shapes and provider errors must not leak into channel-neutral domain/application packages.

## Responsibilities

The adapter owns:

- raw webhook authenticity verification;
- provider webhook parsing and normalization;
- mapping WABA/phone-number assets to the correct `ChannelAccount`;
- text/media/audio/document/image/video inbound normalization;
- delivery/read/error/status normalization;
- outbound text/template/media/interactive message transport where enabled;
- read receipt / typing-indicator transport capability;
- provider error classification to normalized `SendResult`;
- current WhatsApp service-window state;
- provider capabilities/account health metadata.

The adapter does **not** call an LLM, decide reply wording, select business strategy, implement human-like delay, or bypass deterministic policy.

## Account identity

A production WhatsApp channel connection is anchored to a business phone-number asset, not only a human-readable telephone number. Store provider identifiers flexibly, including at minimum current WABA/account and `phone_number_id` identifiers plus display phone number/verified name/quality status when available.

Do not use phone display string alone as an idempotency or tenant key.

## Webhooks

### Verification

Verify the provider webhook using the current Meta raw-body signature requirements before normalization/trusted processing. Fail closed if required verification secret/config is absent.

### Normalized inbound message

Map inbound webhook data into shared message events with:

- stable source event/message ID;
- external contact identity (`wa_id`/current provider identity as supplied);
- channel account / phone-number ID;
- provider timestamp;
- message kind;
- normalized text/caption when present;
- media ID/type/metadata reference when present;
- reply/context reference when present;
- provider metadata retained only in adapter/raw audit fields.

### Status events

Normalize sent/delivered/read/failed provider status events by platform message ID. Do not assume webhook arrival order is chronological; use provider timestamp/state precedence in reconciliation.

### Native/coexistence outbound signals

Where current Meta webhooks expose messages sent natively from the WhatsApp Business App/coexistence surface, provide enough normalized identifiers to correlate known app-originated sends vs unmatched human sends. Unmatched human activity is consumed by shared human-takeover logic.

Exact coexistence echo fields remain implementation-time verified capability, not a hard-coded universal guarantee.

## Window evaluation

Return normalized policy states:

- `OPEN_FREEFORM` while current customer-service window permits free-form customer care;
- `TEMPLATE_ONLY` when arbitrary free-form sending is closed but an approved-template route may be available;
- `NOT_ELIGIBLE` when current policy/account/recipient state prohibits the requested action;
- `UNKNOWN` when eligibility cannot be established safely.

Window evaluation is transport/policy fact reporting. Product policy decides whether a `TEMPLATE_ONLY` state is held, reviewed or scheduled.

## Send paths

### Free-form text

Allowed only when current window/capability policy permits. Map provider response to:

- `ACCEPTED` with `wamid`/platform message ID;
- definite `REJECTED` with retryability/error details;
- `AMBIGUOUS` when network state means the provider may have accepted the request but the system cannot prove outcome.

### Approved template

Template send command must identify an approved current template, language and validated parameter values. Never ask an LLM to freely rewrite template body into provider payload.

### Media/interactive

Capability-gated. Validation must happen before provider side effects. MVP sequencing may support inbound media before outbound rich media; unsupported outbound type returns normalized rejection/capability failure rather than ad-hoc fallback.

## Read + typing presence

Expose optional adapter operations/capabilities for read receipt and text typing indicator. Presence is controlled by application timing policy. Failure to emit presence must never cancel an otherwise valid customer reply; treat it as best-effort telemetry/UX unless current policy says otherwise.

## Voice notes

Inbound audio normalizes as `AUDIO` with media reference. Media download and transcription are separate application/provider services, not the transport adapter's AI responsibility.

## Reliability invariants

- stable provider message IDs are persisted/correlated;
- duplicate webhook delivery is safe;
- unknown event/message types are auditable and fail safe;
- adapter sends are always initiated by delivery/application orchestration;
- ambiguous send outcome is never converted into retryable rejection merely for convenience;
- provider rate/account quality errors remain visible to observability/policy;
- tenant resolution uses trusted configured provider asset IDs, not untrusted payload display values alone.

## Required fixture suite

Cover at least:

- webhook signature success/failure;
- inbound text;
- inbound voice/audio metadata;
- media/document/image/video representative events;
- reply/context message;
- sent/delivered/read/failed statuses including reordered arrival;
- duplicate webhook/source message;
- accepted text send;
- definite provider rejection;
- ambiguous timeout/network outcome;
- free-form window open;
- template-only window;
- approved/unapproved/stale template send validation;
- typing/read presence;
- coexistence/native outbound signal if current Meta sandbox supports it.
