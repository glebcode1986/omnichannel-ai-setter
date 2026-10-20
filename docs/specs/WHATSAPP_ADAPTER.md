# WhatsApp Adapter — Phase 4 Specification

**Status:** Transport implemented in `packages/channel-whatsapp` (P4-01 / Issue #18, 2026-10-04). Platform
facts re-verified the same day; see the re-verification section of
`docs/research/META_WHATSAPP_PHASE4_VERIFICATION.md`.

What P4-01 covers: raw-body verification, inbound normalization, the four window states, free-form text and
approved-template sending, and the read/typing presence effect. What it does not: outbound media and voice
processing (#21), presence timing policy (#22), coexistence onboarding (#23) and the vertical slice (#24).
The adapter reports `interactive: false` until a task turns it on.

Embedded Signup and the account lifecycle landed with P4-02 / Issue #19; see
`docs/specs/WHATSAPP_ONBOARDING.md`.

## Template catalogue and the outside-window policy (P4-03 / Issue #20)

Platform rules re-verified 2026-10-04; see the Issue #20 section of
`docs/research/META_WHATSAPP_PHASE4_VERIFICATION.md`.

**Only `APPROVED` sends, and approval is not permanent.** Quality feedback moves an approved template to
`PAUSED` or `DISABLED`, unused templates are archived after twelve months, and none of it is announced
synchronously. So a stored status carries `syncedAt`, a row older than the caller's freshness bound is
treated as unknown rather than approved, and `message_template_status_update` is applied to every
connection on the messaging account as it arrives.

**A template is identified by name and language**, never by name alone.

**The approved shape is parsed once, at sync.** `parameter_format` is `positional` or `named`, defaulting
to positional, and the two serialize differently — a named template's values each carry a
`parameter_name`. Deriving the shape at send time would put a parser in the dispatch path.

**Eligibility is decided deterministically, before the policy engine sees it.** A model may rank or suggest
a template; everything that makes a suggestion sendable is checked against the stored catalogue, and a
suggestion that fails is refused rather than repaired — substituting a template that would have worked
would be this layer choosing the words a customer reads. The policy engine is told two booleans and never
which template.

**The three ADR-016 modes behave as follows outside the window.** `SERVICE_WINDOW_ONLY` stops automation
until the customer writes again. `TEMPLATE_REVIEW` holds for an authorized person, whatever the allowlist
says. `TEMPLATE_AUTOPILOT` schedules an allowlisted template and otherwise holds for a person. With no
approved template at all the matter ends rather than queueing a review nobody can resolve. Free-form
content is refused in every mode, whoever approved it: no click reopens a messaging window.

**Still open at P4-03.** Dispatching an outside-window template — composing the proposal, carrying it
through the delivery command and recording the send — waits for a caller that can produce one. The draft
engine proposes no template today, so building the dispatch path now would be unreachable code; the
eligibility, validation and policy pieces it needs are in place and tested.

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

### Implemented (P4-05)

`markReadAndTyping` is the whole of the adapter's part, and it is deliberately *not* on `ChannelAdapter`:
core code takes a plain adapter and therefore cannot reach presence, because the timing is the
application's decision and a transport must never take it on.

- **One request, and the read status is not optional.** Meta documents a single payload for the indicator
  and it carries `status: "read"` and `message_id` as required fields. There is no typing-only request, so
  a caller asking for the indicator necessarily marks the message read. Re-sending that status for a
  message already marked read is behaviour the documentation describes neither way; the worst case is a
  refused presence call, which is a cosmetic loss by contract.
- **Marking one message marks the earlier ones.** Meta cascades the receipt through the conversation, so
  the newest inbound message covers a whole debounced burst in one call.
- **Two platform bounds are exported** rather than restated by callers: `TYPING_INDICATOR_TTL_MS`
  (25 s — the indicator is dismissed when the reply arrives or after that, whichever comes first) and
  `MARK_READ_MAX_AGE_MS` (30 days). The application bounds its own lead by the first and refuses a message
  older than the second.
- **A number that is not connected is refused**, exactly as a send is, and before the credential is read.
- The result is a boolean. Nothing a caller can do about a failed presence effect is worth changing a
  reply for.

## Voice notes

Inbound audio normalizes as `AUDIO` with media reference. Media download and transcription are separate application/provider services, not the transport adapter's AI responsibility.

### Media retrieval (implemented, P4-04)

The adapter owns the provider calls and nothing about transcripts:

- `resolveMediaUrl` (`GET /<MEDIA_ID>`) then `downloadMedia` against the returned URL. Two requests, because
  that is the documented shape. The resolved URL lives five minutes and is never persisted; a media ID from
  a webhook lives seven days, so a reading attempted after that is refused locally rather than retried.
- `phone_number_id` is sent on every media call. It is the provider's own tenancy check on an ID that
  arrived from an untrusted webhook, not a convenience.
- Type and size are refused **before** the transfer, on the provider's own `mime_type` and `file_size`, and
  the actual length is re-checked afterwards: a stated size is a claim the response can break.
- Per-type platform limits are used rather than one limit of our own, because they differ by a factor of
  twenty and the document limit would admit an audio file six times what the platform allows.
- Every media call is refused when the channel account is not `CONNECTED`, exactly as a send is. A stored
  token outlives the authorization it was granted under, so leaving this to the provider would keep
  downloading a business's customers' recordings after that business removed the integration.
- `deleteMedia` (`DELETE /<MEDIA_ID>`) is the retention hook that reaches the provider's own storage.
- Each failure carries a reason in this codebase's vocabulary, never the provider's prose, and the caller
  judges retryability from the reason: `EXPIRED` is worth another attempt because its documented remedy is
  re-resolution; `UNSUPPORTED_TYPE`, `TOO_LARGE`, `MIME_MISMATCH` and `NOT_FOUND` never are.

## Coexistence (implemented, P4-06)

A business on coexistence keeps answering customers from the WhatsApp Business App while this product
answers from the Cloud API. Three things follow, and all three are about *authorship*.

- **Native sends arrive on `smb_message_echoes`, their own webhook field.** Not on `messages`, which
  carries customer-to-business traffic only. The adapter emits them as `OUTBOUND_ECHO` and stops there.
- **The adapter never decides whether an echo means a takeover.** It cannot: Meta publishes no device,
  operator or origin field, so a send by the owner on the phone, one by staff on a linked laptop and one
  this product made itself are indistinguishable in the payload. The application correlates the message id
  against this product's own sends instead (ADR-013).
- **An echo that cannot be correlated is treated as a person's.** The doubt is resolved towards taking
  over, because the two errors are not symmetric: a missed native reply means the assistant drafts over a
  colleague who is already handling the conversation, while our own send mistaken for a colleague means a
  pause somebody can undo.

An account that is not on coexistence reports `nativeOutboundVisible: false`, and the product says so on
the channel card rather than behaving as though no native replies happen.

### Account lifecycle

`account_update` carries `ACCOUNT_OFFBOARDED` (device change or re-registration), `PARTNER_REMOVED` (an
explicit Disconnect inside the app) and `ACCOUNT_RECONNECTED`. An offboard marks the number
`NEEDS_REAUTH`, which is how "pause any pending Cloud API message sends" — Meta's own instruction — is
honoured: the policy engine already refuses an unhealthy account and the delivery claim re-asserts it, so
a reply scheduled earlier is held when it comes due. Not `DISCONNECTED`, because reconnection is
automatic and usually takes minutes. Reconnection restores only an account that left for this reason.

An event this adapter has not been taught is ignored rather than guessed into one of the two answers.

## Delivery (implemented, P4-07)

One `DeliverySendPort` per channel behind one coordinator: which transport a reply leaves on is resolved
from the channel its account names, and nothing above that boundary branches on it. The sender carries
free-form text only — WhatsApp's route out of a closed window is an approved template, which the draft
engine does not propose today, so a delivery that would need one is refused by the window gate rather than
downgraded into something else.

Two rules are Instagram's and do **not** apply here: the Human Agent exception, and the automated-dispatch
deadline that requires an automated experience to answer within seconds. Applying either to WhatsApp would
be inventing a rule — and the deadline would do visible damage, shortening the human-like delay on every
reply.

`docs/specs/WHATSAPP_SLICE_MANUAL_TEST.md` is the sandbox plan for what only a real account can show.

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
