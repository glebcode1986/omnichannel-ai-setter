# Meta WhatsApp Phase 4 Verification — 2026-09-16

**Purpose:** implementation-time baseline for the official WhatsApp Business Platform. Re-verify current Meta documentation/API version before shipping or App Review; platform behavior can change.

## Re-verification 2026-10-04 (P4-01 implementation)

Checked against Meta's live documentation while implementing `packages/channel-whatsapp`. Three things
changed or sharpened since the 2026-09-16 baseline:

- **Graph API version.** The current version is **v26.0**, released 2026-07-29, and Meta's own Cloud API
  examples now use it. The adapter's default moved from the draft value to v26.0. v23.0 remains available
  until 2027-10-08, so this is a default, not a cliff.
- **Typing indicator.** Confirmed as a combined read receipt plus `typing_indicator: { type: "text" }` on
  `POST /<PHONE_NUMBER_ID>/messages`, answering `{"success": true}`. Newly recorded, because it decides
  where the call belongs: **the indicator disappears when the reply arrives or after 25 seconds**, whichever
  is first, while the product's human-like delay is 30–120 seconds. Emitting typing at scheduling time
  would show it, drop it, and leave the customer watching nothing — so presence must be emitted near the
  send, which is now stated in the adapter rather than implied.
- **Error codes.** `131047` is documented as "Last message sent to recipient was more than 24 hours ago.
  Send a template message instead" — the platform stating the window model in one line. `130429` (rate
  limit) and `131048` (per-number messaging limits) are the transient ones; `131026`, `131051`, `131052`,
  `131053`, `131031`, `368` and the `132xxx` template failures are final. One addition against the draft:
  `131052` is their *download* of our media failing and `131053` their *upload* of it, and both are final.

Still implementation-time capability rather than guarantee, unchanged from the baseline: coexistence echo
fields, and whether a given account may use the coexistence path at all.

## Verified official platform direction

- Use **WhatsApp Cloud API**, not WhatsApp Web/Baileys/QR automation, for production transport.
- Messages are sent through `/{PHONE_NUMBER_ID}/messages` and tracked by stable WhatsApp message IDs (`wamid...`) with webhook status updates.
- The official Messages API supports text, media (audio, document, image, video), templates, marking messages read, and typing indicators.
- A WhatsApp Business Account (WABA) subscription delivers webhook events for its phone numbers; an app subscribes through `/{WABA_ID}/subscribed_apps`.
- Phone numbers have provider IDs and quality/status metadata that should be treated as channel-account health/capability data.

## Customer-service window

A user/customer message opens the current 24-hour customer-service window. During the open service window, supported free-form customer-care messages can be sent according to current WhatsApp policy. Outside that window, arbitrary free-form continuation is not the supported path; approved message templates are the relevant business-initiated mechanism.

**Architecture consequence:** WhatsApp window evaluation must distinguish at least:

- `OPEN_FREEFORM`
- `TEMPLATE_ONLY`
- `NOT_ELIGIBLE/UNKNOWN` where account/policy state cannot safely authorize a send

The LLM never overrides this decision.

## Message templates

- Templates are created/managed under the WABA and have approval/status/category/language metadata.
- Sending a template uses the same phone-number Messages endpoint with `type=template` and a specific approved template definition/parameters.
- Template catalog/version/status must be refreshed; a previously approved template cannot be assumed perpetually usable.
- Dynamic template variable values are data substitutions, not permission to rewrite the approved template arbitrarily.

## Typing indicator and read receipt

The official Cloud API supports a combined read receipt + text typing indicator through the Messages endpoint, referencing the inbound WhatsApp message ID. This can be used as a presence effect near delivery time; it is not a substitute for the durable human-delay queue.

**Product timing rule:** do not immediately show typing for the whole 30–120 second human-like delay. A future presence policy can mark read and emit typing closer to actual send, while final delivery still passes the shared pre-send gate.

## Webhook/status behavior

WhatsApp status webhooks can report sent/delivered/read states. Their arrival order is not guaranteed to reflect chronological message timing, so state reconciliation must compare provider timestamps/current state rather than assuming webhook arrival order.

Webhook authenticity must be verified on the raw request body before trusted processing. The wacrm reference implementation uses fail-closed HMAC-SHA256 verification with constant-time comparison; our exact implementation remains adapter-specific.

## Embedded Signup for SaaS onboarding

Meta's Embedded Signup is the intended partner/SaaS onboarding path. Current official flow/documentation includes:

1. embed the signup flow in the product/client portal;
2. obtain/shared WABA identifiers;
3. add/assign system-user access as required;
4. register the selected phone number;
5. subscribe the app to the WABA's webhooks;
6. fetch templates/capabilities after onboarding.

Current documentation also states phone registration after Embedded Signup is time-bounded (currently described as within 14 days) and Cloud API registration enables two-step verification with a 6-digit PIN. Re-verify this exact timing/process when implementing.

Permissions currently referenced by Meta onboarding/management documentation include `whatsapp_business_management`; sending uses `whatsapp_business_messaging`. Exact App Review/advanced-access requirements must be re-verified at implementation time.

## Coexistence / existing WhatsApp Business App number

Current 2026 ecosystem documentation indicates Meta supports a coexistence path for eligible businesses where an existing WhatsApp Business App number can remain usable while Cloud API is connected. However, eligibility/onboarding details and account-model behavior are evolving.

**Decision for architecture:** model coexistence as a capability/onboarding mode, not as a universal assumption. Do not promise every account/region can use it until the current Embedded Signup response/capabilities prove eligibility.

If native-app outbound echoes/events are exposed for a coexistence connection, unmatched human-originated sends should feed the same human-takeover logic used by Instagram. Exact webhook field(s) must be re-verified against current Meta docs before implementation.

## Evolving WhatsApp account model

Meta is evolving WhatsApp account/partner architecture. Do not encode `WABA_ID == permanent single tenant transport identity` too deeply in the domain. Channel-specific config should preserve external asset identifiers flexibly (business/WABA/account/phone number IDs and future account-model identifiers) behind `ChannelAccount` metadata/provider records.

## Media and voice notes

Cloud API supports audio/media messages. Inbound audio should be persisted first as media metadata/reference. Voice understanding is a separate application capability:

1. securely fetch/download permitted media;
2. transcribe through a bounded transcription provider;
3. store transcript/provenance separately from raw media metadata;
4. feed transcript as untrusted conversation content into the AI draft engine;
5. hold/escalate if download/transcription fails rather than inventing content.

## Open product decision: outside-window templates

The product owner has **not yet selected** whether approved WhatsApp templates outside the 24-hour window should be:

- `SERVICE_WINDOW_ONLY`: AI conversation automation stops outside the window until the customer messages again; or
- `TEMPLATE_ASSISTED`: the system may select/propose an eligible approved template outside the window, with the degree of automatic vs human approval configurable/decided separately.

Do not freeze automatic template sending without product-owner approval.

## Sources checked 2026-09-16

Official Meta WhatsApp Business Platform/Postman collection was used to verify Cloud API messages/media/templates, WABA subscription, phone registration, Embedded Signup, typing/read receipts and status webhook behavior. Public product/provider documentation was used only as secondary evidence for coexistence; implementation must verify current Meta eligibility directly.

## Re-verification for P4-02 / Issue #19 — Embedded Signup, 2026-10-04

Read directly from Meta's live documentation on 2026-10-04. Every value below is a **provider rule of the
day**, not a domain constant: the package holds them as defaults an operator can override, exactly as the
transport holds the Graph version.

### The deadline that shapes this task

**Embedded Signup versions 2 and 3 — including their public previews — are deprecated on 15 October 2026.**
Meta's banner appears on every Embedded Signup page: migrate to **version 4** before that date. Eleven days
from today, so the implementation targets v4 only. There is no "support both" option worth building; v2/v3
stop working.

### The account model is splitting, and `waba_id` has quietly changed meaning

Meta is separating the WhatsApp Business Account into a **WhatsApp Account (WAAC)** — phone numbers and
identity — and a **Messaging Account** — templates, billing and webhook subscriptions. Existing `waba_id`
values keep working and **now denote the messaging-account ID**; the implementation page says so in the
field table for the session-log payload:

> `waba_id` … "which now denotes the messaging account ID"

This vindicates keeping `wabaId` a field of its own in #18 rather than deriving it. The onboarding store
keeps `waba_id` as the messaging-account identifier and `phone_number_id` as the sending asset, and treats
the business portfolio ID as a third, separate thing. Nothing in the core domain learns any of the three.

### Scopes and roles

- `whatsapp_business_management` — manage the messaging account, templates, phone numbers;
- `whatsapp_business_messaging` — send and receive;
- `business_management` — needed by the system user whose token the provider supplies, which must also hold
  an **Admin** or **Finance Editor** role in the business portfolio.

The Business Login configuration is built from the **"WhatsApp Embedded Signup configuration with 60-day
token"** template, and Meta's own guidance is to request only the assets actually needed: a customer who
reaches a catalogue-selection screen for a product that does not use catalogues abandons the flow and asks
why.

### The client flow (v4)

```js
FB.login(fbLoginCallback, {
  config_id: '<CONFIGURATION_ID>',
  response_type: 'code',
  override_default_response_type: true,
  extras: { setup: {} },
});
```

Two channels carry the result, and they are not interchangeable:

1. **`window.postMessage`**, filtered on `event.origin.endsWith('facebook.com')`, with
   `data.type === 'WA_EMBEDDED_SIGNUP'`. On success it carries `phone_number_id`, `waba_id`,
   `business_id`, optional `waba_ids`/`page_ids`/`catalog_ids`/… arrays, and `event` ∈
   `FINISH`, `FINISH_ONLY_WABA`, `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`, `FINISH_OBO_MIGRATION`,
   `FINISH_GRANT_ONLY_API_ACCESS`, `ERROR`. On abandonment `event: 'CANCEL'` with `data.current_step`. A
   reported error carries `error_message`, `error_code`, `session_id`, `timestamp`.
2. **The login callback**, whose `response.authResponse.code` is the exchangeable token code.

**Closing the final screen counts as success**, not as a cancel: Meta states that both pressing Done and
dismissing the popup on the last screen return the code and the session object.

**The exchangeable code is valid for 30 seconds.** That single number decides the shape of the server
flow: the code may never be persisted, queued or retried later — the exchange happens in the request that
receives it, and an expiry is an ordinary refusal with a resumable state rather than an error.

`FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` is the flow finishing with a number that is on the WhatsApp
Business App — which is what makes coexistence a *provider-reported* mode rather than something the UI may
promise in advance.

### The server-side onboarding calls, in order

All of them server-to-server; Meta says explicitly not to make these from the client.

1. **Exchange the code for the business token**

   ```
   GET https://graph.facebook.com/<version>/oauth/access_token
       ?client_id=<APP_ID>&client_secret=<APP_SECRET>&code=<CODE>
   ```

   Returns the business-integration system-user access token ("business token").

2. **Subscribe the app to the customer's messaging account**

   ```
   POST https://graph.facebook.com/<version>/<WABA_ID>/subscribed_apps
   Authorization: Bearer <BUSINESS_TOKEN>
   → { "success": true }
   ```

   The app must already be subscribed to the **`account_update`** webhook field, which fires every time a
   customer completes Embedded Signup.

3. **Register the customer's phone number for the Cloud API**

   ```
   POST https://graph.facebook.com/<version>/<PHONE_NUMBER_ID>/register
   Authorization: Bearer <BUSINESS_TOKEN>
   { "messaging_product": "whatsapp", "pin": "<SIX_DIGITS>" }
   → { "success": true }
   ```

   The PIN is the number's two-step verification code and is exactly six digits.

4. *(optional)* a test message, which also opens the service window.

5. **Calling is off by default.** The WhatsApp Business Calling API has to be enabled per phone number;
   nothing in this product turns it on.

6. **The customer adds a payment method** in WhatsApp Manager
   (`https://business.facebook.com/wa/manage/home/`). Until they do, onboarding is not finished on Meta's
   side however complete it looks on ours — which is why the connection carries a provider-derived health
   state rather than a boolean.

### Testing

Meta's own test path is to run the flow with the provider's Meta credentials; anyone added to the app as
Admin or Developer can do the same. **Test accounts expire after 30 days.** No production credential of
any kind appears in this repository's tests; every provider response in the suite is a fixture.

## Re-verification for P4-03 / Issue #20 — templates and the window, 2026-10-04

Read from Meta's live template documentation and webhook reference on 2026-10-04. The issue asks for
current template and service-window rules to be re-verified; these are the ones the implementation rests
on, and three of them changed what the code does rather than merely confirming it.

### The platform fact ADR-016 is built on

> "Template messages are the only type of message you can send to WhatsApp users outside the customer
> service window."

That is why `TEMPLATE_ONLY` is a window *state* and not a closed window, and why the outside-window policy
has three modes rather than a boolean.

### Only `APPROVED` may send, and approval is not permanent

A template must reach `APPROVED` before it can be used in a message, and Meta's wording is that a template
rejected — or whose status changed to anything else — cannot be used. The statuses that matter:

- `PENDING`, `REJECTED`, `IN_APPEAL`: never sendable;
- `APPROVED` with quality *unknown*, *high*, *medium* or *low*: all sendable. A low-quality approved
  template still sends, and Meta says it may be paused or disabled soon;
- `PAUSED` and `DISABLED`: **not** sendable. These arrive *after* approval, from quality feedback;
- `PENDING_DELETION`: added as a `message_template_status_update` event value.

So a status cached at connect time is a record, not a permission — which is why eligibility reads
`syncedAt` and a row older than the caller's freshness bound is treated as unknown rather than approved.

Two more ways a catalogue row can describe a template that no longer exists: **unused templates are
archived after 12 months and deleted 28 days later**, and a messaging account holds at most 250 templates
(6,000 if the business portfolio is verified and one of its WhatsApp accounts has a verified display name).

### Status changes arrive by webhook, and the field names are exact

- `message_template_status_update` — a status changed;
- `message_template_quality_update` — the quality score changed;
- `message_template_components_update`, `template_category_update`.

None of the four supports a callback override. Two operational facts from the same reference shape the
handler: the **maximum webhook payload is 3 MB**, and Meta **retries a failed delivery with decreasing
frequency for up to 7 days, delivering retries to every subscribed app** — so a duplicate status update is
ordinary rather than exceptional, and applying one has to be idempotent.

### A template is identified by name *and* language

Template names are deliberately **not unique**: one name exists once per language, and each language
counts separately against the account's limit. Sending the English version of a template a Russian-speaking
customer was promised is sending different words, which is why `LANGUAGE_NOT_APPROVED` is a refusal of its
own rather than folded into "not in the catalogue".

### Two parameter formats, and they do not serialize the same way

This is the finding that fixed a defect. `parameter_format` is `positional` or `named`, and **defaults to
`positional`** when a template does not declare one.

- **Positional**: placeholders are `{{1}}`, `{{2}}`; send values carry only `type` and `text`, and they
  must be in the same order as the placeholders.
- **Named**: placeholders are `{{snake_case}}`; **every send value must carry its own `parameter_name`**,
  and order does not matter.

P4-01's `buildTemplatePayload` emitted positional parameters for everything, so a business whose templates
use named parameters could not send a template at all — Meta refuses the payload. It now derives the format
from the names (a positional parameter's name *is* a number; a named one's cannot be) and serializes
accordingly, and the approved shape is parsed once at sync rather than on the way to a customer.

### What Meta's current documentation does *not* say

It publishes no whitespace rule for parameter values — no "no newlines, tabs or more than four consecutive
spaces". Older community material states one; the current reference does not, so nothing in this
implementation refuses on it. A local refusal we cannot point at is a rule of our own pretending to be the
platform's, and it would reject sends the provider would have accepted.

### Also noted, for the tasks after this one

- **Delivery order across messages is not guaranteed.** To order a sequence, wait for the `delivered`
  status webhook before sending the next one.
- Per-conversation limits cap how many templates may be sent outside the window, and marketing template
  messages are additionally rate-limited per recipient. Both are provider quotas rather than product
  policy, and they surface as send refusals.
- A template's `expiration` (delivery retry period) is set at creation and is the provider's, not ours.

## Re-verification for P4-04 / Issue #21 — media and voice notes, 2026-10-04/05

Re-read against Meta's live WhatsApp Cloud API reference and OpenAI's live API documentation before
implementing. Everything below is a platform or provider fact; the design decisions that follow from them
are in the implementation's own comments.

### Fetching a recording is two requests, and both halves are short-lived

`GET /<MEDIA_ID>` answers with `url`, `mime_type`, `sha256`, `file_size` and `id`; the bytes come from a
second request to that `url`. Two lifetimes, different and both short:

- the **resolved URL lives five minutes**, which is why it is never persisted;
- a **media ID from a webhook lives seven days** — not the thirty an *uploaded* one gets.

A 404 on the resolved URL is Meta's own answer for one that expired, and its documented remedy is to
resolve the media ID again. That is the only media failure worth retrying for that reason.

### `phone_number_id` on the media calls is the provider's tenancy check

Both `GET /<MEDIA_ID>` and the delete accept `phone_number_id`, and it is not a convenience: a media ID
arrives from an untrusted webhook, and without the parameter one business could resolve another's media.
It is sent on every call.

### The per-type size limits are the platform's, and they differ by a factor of twenty

Audio 16 MB, image 5 MB, video 16 MB, document 100 MB, sticker 500 KB (static) / 100 KB (animated), with
100 MB overall. Accepting a 100 MB "voice note" because *documents* may be that large would hand a
transcriber a file six times what the platform allows for audio. Webhook error 131052 is the download
failure; 131053 is a MIME type that does not match the file.

`OGG` is accepted for audio **only** with the OPUS codec, and voice notes are mono.

### `DELETE /<MEDIA_ID>` exists, which is what makes a retention hook reach the provider

Meta keeps uploaded media for thirty days unless it is deleted sooner, so this is the one call that makes a
customer's deletion request reach the provider's storage rather than only ours.

### The transcription provider: `whisper-1` is on the way out

OpenAI's documentation moved to `developers.openai.com`; `platform.openai.com` now answers 403/301 for
these pages.

- `POST https://api.openai.com/v1/audio/transcriptions`, multipart.
- **`whisper-1` was notified deprecated on 2026-08-26 and is removed from the API on 2027-02-26.**
  `gpt-transcribe` is the documented replacement and is this product's default.
- Documented input formats: `mp3`, `mp4`, `mpeg`, `mpga`, `m4a`, `wav`, `webm`. **`ogg` is not in the live
  guide's list**, though the official OpenAPI spec still names it — a list that reads like a Whisper-era
  leftover. WhatsApp voice notes are `audio/ogg; codecs=opus`, so the two documents disagree about exactly
  the format this product receives most.
- 25 MB request cap, with **no documented 413**: the refusal's shape is not published, so a local size
  check is the only reliable one.
- `Retry-After` is sent on 429 and 503. The quota codes that must *not* be retried are
  `insufficient_quota`, `credit_balance_exhausted`, `organization_spend_limit_exceeded`,
  `project_spend_limit_exceeded` and `organization_usage_limit_exceeded`.
- `usage` is a union discriminated on `type` (`tokens` or `duration`), so a duration read from the wrong
  variant is a token count wearing a seconds label.
- `gpt-transcribe` additionally accepts `language`/`languages[]` and `keywords[]`, and returns
  `languages: [{code}]` — an empty array meaning it could not detect one.

### There is no whole-response confidence anywhere in that API

Worth stating plainly, because a confidence figure is exactly the kind of number a later reader assumes
exists. Per-token logprobs are available only on the `gpt-4o-transcribe` family, and per-segment
`avg_logprob`/`no_speech_prob` only on `whisper-1` through `verbose_json` — and **every one of those models
is removed on the same 2027-02-26 date**. `gpt-transcribe` reports neither.

So this implementation asks for neither, the port's confidence field is optional, and a CHECK refuses a
stored number that does not say where it came from. A figure nobody measured, attached to a reading of a
customer's own words, is what that prevents.

### Decisions the product owner made on this task

- **Model: `gpt-transcribe`** rather than `whisper-1`.
- **No transcoding.** The recording is sent as it arrived, with an accurate filename and content type, and
  the provider's own answer settles whether it can read an OGG/Opus container. Guessing the rule either way
  would be inventing one; a refusal becomes a typed failure and a review item, never a transcript.

### Sources checked 2026-10-04/05

Meta: WhatsApp Cloud API media reference (retrieve, download, delete, supported types and sizes), webhook
error codes 131052/131053, and the Cloud API changelog. OpenAI: the live speech-to-text guide, the
`createTranscription` API reference, the deprecations page, the error-code and rate-limit guides, the
`gpt-transcribe` and `whisper-1` model pages, and the published OpenAPI specification.

## Re-verification for P4-05 / Issue #22 — read receipts and the typing indicator, 2026-10-05

Re-read against Meta's live documentation before implementing. The pages moved: typing indicators are
**not** under `/guides/` — `…/cloud-api/guides/typing-indicators` answers 404 — and live at
`developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators/`, mirrored at
`…/documentation/business-messaging/whatsapp/typing-indicators`. Mark-as-read exists at both the
`/guides/` and `/documentation/` paths with identical content.

### The read status is not optional when asking for the indicator

One endpoint and one payload for all of it — `POST /<PHONE_NUMBER_ID>/messages`:

```json
{ "messaging_product": "whatsapp", "status": "read", "message_id": "<WAMID>", "typing_indicator": { "type": "text" } }
```

The guide's parameter table marks **both `status: "read"` and `message_id` as required** alongside
`typing_indicator`, and **no typing-only variant is documented anywhere**. `"text"` is the only documented
value for `typing_indicator.type`.

Worth recording precisely because it is a constraint on the product: read receipts and the typing
indicator cannot be offered to an owner as two independent switches, because the platform does not offer
them that way. Hence one three-valued setting rather than two booleans.

A caveat the implementation does not lean on: the **API reference** schema (`MarkMessageRequestPayload`)
lists only `message_id`, `messaging_product` and `status` — `typing_indicator` is absent from it
entirely, and it enumerates no allowed `status` values. The indicator is documented in the guide only.

### The lifetime, verbatim

> "The typing indicator will be dismissed once you respond, or after 25 seconds, whichever comes first."

The same page adds: "To prevent a poor user experience, only display a typing indicator if you are going
to respond." That sentence is the reason presence is never announced for a draft held for review, nor for
a channel this deployment cannot actually send on.

### Marking read: a 30-day bound, and it cascades

> "Mark incoming messages as read within 30 days of receipt."

> "When you mark a message as read, the API also marks earlier messages in the conversation as read."

The cascade is useful rather than incidental: this product debounces a burst of customer messages, so
marking the newest covers the whole burst in one call. The id is the inbound `wamid` from a `messages`
webhook.

**Not documented:** what happens when an already-read message is marked read again. Nothing here relies
on it being idempotent — the second call exists to raise the indicator, and the read status is a required
field of that request rather than an assumption about its behaviour.

### Errors and limits: thinner than they look

- **131009** "Parameter value is not valid" is the *only* code the documentation attributes to these
  calls, and only for an invalid message id.
- The error-code reference contains no occurrence of "read", "typing" or "wamid", and attributes no code
  to either operation. What Meta returns for a well-formed but expired (>30 days) id, for an unregistered
  number, or for throttling on these specific calls is **unstated**, so the adapter treats any
  non-2xx as a refusal rather than matching a code list it cannot rely on.
- **No dedicated rate limit is documented.** The throughput page (80 mps default) never mentions read
  receipts or typing indicators, so whether they count toward it is not stated either way. The queue
  family is given its own modest limit rather than assuming an answer.
- The success response is `{"success": true}` with **no message id** — the HTTP status is the whole
  verdict.

### Coexistence

Typing indicators and read receipts appear in **neither** the supported nor the unsupported column of the
Business App coexistence feature table. Unstated, so nothing is promised about them in that mode.

### Sources checked 2026-10-05

Meta: the Cloud API typing-indicators page and its `/documentation/` mirror, mark-message-as-read on both
paths, the message API reference schema, the error-codes reference, the throughput and messaging-limits
pages, and the coexistence onboarding page.
