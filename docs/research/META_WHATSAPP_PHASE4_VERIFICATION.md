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

## Re-verification 2026-10-16 (P4-02 propagation, directive dated 2026-10-15)

Read from Meta's live documentation on **2026-10-15 and 2026-10-16**, the day of and the day after the
Embedded Signup deprecation date this task was built around. Verification was split across the surfaces the
directive named; every exact value below is quoted from a primary Meta page, and where a value could *not*
be corroborated that is stated rather than smoothed over.

**Outcome: no code change was required by this pass.** Three documented risks were checked against the
implementation and found absent; one documented wording change strengthens the echo repair shipped in this
same commit. The one thing that did change is the status of a deadline, and it changed by passing.

### The deprecation date passed, and Meta has not confirmed enforcement

| Version | Released | Available until |
|---|---|---|
| v4 | 2025-10-08 | **TBD** |
| v4-public-preview | 2026-05-12 | TBD |
| v3 | 2025-05-29 | "October, 2026" |
| v2 | January 2023 | "October, 2026" |

The versions page states: *"The latest Embedded Signup Version is: v4."* The site-wide banner still reads
**"Embedded signup v2 will be deprecated on October 15, 2026"** — in the future tense, one day after that
date. The v2, v3 and both public-preview pages are still served and unmarked as retired, and the WhatsApp
changelog's newest entry is **2026-05-12**, with no September or October 2026 entry at all.

Two precision corrections to the 2026-10-04 baseline, which recorded "versions 2 and 3 … are deprecated on
15 October 2026":

- The **versions page** gives v3 and v3-public-preview only `"October, 2026"` — a month, no day — and the v3
  page itself carries only the v2 banner and states no v3 date. The sole primary source naming 15 October
  for v3 is the blog post of 2026-05-14: *"Embedded signup v2 and v3 will be deprecated on October 15,
  2026."* The baseline's claim is **sourced and correct, but it rests on the blog, not the versions table**,
  and the two do not reconcile.
- **Enforcement is unverified.** The date is announced-and-reached, not observed-and-enforced. Nothing in
  this repository depends on the distinction — `onboarding.ts` targets v4 only and always has — but a claim
  that v2/v3 "are now off" would not be supportable from Meta's own pages today.

One trap recorded for completeness, because it names coexistence: v2 integrations using the feature types
`only_waba_sharing`, `marketing_messages_lite` or `coex` *"cannot be automatically upgraded"* and after the
date *"will default to the standard embedded signup flow"*. **This repository sends none of those three**
(`git grep` finds no occurrence), so the trap does not apply here.

### Graph API version: unchanged, and no v27.0 exists

`v26.0` remains current, released **2026-07-29**, expiry **TBD**. **No v27.0 exists** on the versions page.
`v23.0` expires **2027-10-08**, which is exactly what this file already recorded — so the illustrative
`v23.0` in `packages/channel-whatsapp/src/config.ts` names a version that is still supported for another
year, and is a default's example rather than a stale value. `v20.0` expired 2026-09-24, before the previous
baseline. Versions inside their window today: v21.0 – v26.0.

Note for anyone reading Meta's samples: the WhatsApp reference curl examples still pin `v25.0` while the
Graph version train is at `v26.0`. Treat that as doc lag; no page states a minimum version for v4.

### Scopes: two are mandatory, and the third is not a customer grant

Meta's permissions page lists exactly two mandatory scopes for this integration —
`whatsapp_business_management` and `whatsapp_business_messaging` — and calls `business_management`
**optional and "rarely necessary"**; it is absent from the entire v4 product→permission table. In v4 scopes
are no longer hand-picked: *"Selecting the products will automatically set you to v4."*

The implementation already matches this. `EMBEDDED_SIGNUP_SCOPES` is exactly the two mandatory scopes, and
`SYSTEM_USER_SCOPE = "business_management"` is documented in the same file as the scope the **provider's own
system user** needs alongside an Admin or Finance Editor role — *not* something requested from the customer.
Those are two different subjects, so the baseline's §"Scopes and roles" entry and Meta's "rarely necessary"
are both true and do not conflict.

### The 30-second code, and what the app settings must contain

The exchangeable code's **30-second** lifetime is unchanged, and it remains the fact that shapes the server
flow: the code is never persisted, queued or retried, and an expiry is an ordinary resumable refusal.
`SIGNUP_CODE_TTL_MS = 30_000` states it in code.

The app-settings requirement is confirmed verbatim, and it is a conjunction, not a choice: the flow returns
the IDs and the code *"only if the domain of the page that spawned the flow is listed in the **Allowed
domains** … **and Valid OAuth redirect URIs** fields."* Also *"Only domains that have enabled HTTPS are
supported."* Six toggles under Facebook Login for Business → Settings → Client OAuth settings must be on:
Client OAuth login, Web OAuth login, Enforce HTTPS, Embedded Browser OAuth Login, Strict Mode for redirect
URIs, and Login with the JavaScript SDK. Upgrading to v4 requires creating a **new** configuration.

**`sessionInfoVersion` is not corroborated by Meta for v4.** The versions page documents it only for v2,
with the value `3`, and says session-info logging is returned automatically from v3 onward; neither the v4
page nor the implementation page mentions it, and the current `FB.login` sample carries only
`extras: { setup: {} }`. The widely-copied `version: 4, sessionInfoVersion: 4` snippet traces to third-party
integrator guides, not to Meta. **Checked: this repository sends no `sessionInfoVersion` at all**, so it
hard-codes nothing Meta does not publish.

### The six-digit PIN

Confirmed at **6 digits**, required, in two places that are both the server's responsibility and neither of
which is part of the Embedded Signup UI:

- `POST /<PHONE_NUMBER_ID>/register` with body `messaging_product: "whatsapp"` and `pin` — both Required.
  Meta's wording: *"Set this value to a 6-digit number. This will be the business phone number's two-step
  verification PIN."* Two-step verification is mandatory, and if the number **already** has it the existing
  PIN must be sent at registration time.
- Two-step verification set or changed via `POST /<PHONE_NUMBER_ID>` with a `pin` field.

**Constraints beyond "6-digit" are undocumented** — no page states allowed characters, leading zeros, or
whether repeated digits are rejected. The implementation refuses a PIN that is not six digits *before* any
provider call, which is exactly the documented rule and no more; anything stricter would be an assumption.

`data_localization_region` and `meta_store_retention_minutes` are now marked deprecated in the register
schema (v21+), and the latter has min = max = 60, so it has one legal value. Neither is sent here.

### The account model is splitting, with dated phases

Meta's **"Account model evolution"** page (beta; its own changelog dates it 2026-05-01) decomposes the WABA
into two assets rather than renaming it:

- a **WhatsApp Account (WAAC)** — *"a container to hold a single business phone number and in the future a
  single business username"*, always owned by the client or direct developer;
- a **Messaging Account** — *"a container for your templates, billing, and webhook subscriptions"*, ownable
  by client or partner.

The continuity rules matter more than the names: *"Existing WABA IDs remain the same and denote Messaging
Account IDs."* *"Your existing phone number IDs continue to work with all APIs."* *"WhatsApp Account IDs and
phone number IDs have a 1:1 relationship, but are different values."* And the shape change that breaks the
old tree: *"A business phone number can be associated with multiple Messaging Accounts."*

This vindicates the baseline's reading that `waba_id` now denotes the messaging-account ID, and it vindicates
keeping `wabaId`, `phoneNumberId` and the business portfolio ID as three separate stored fields with none of
them reaching the core domain. Phases, as published: **Phase 1** general availability H2 2026, no code
change except multi-Messaging-Account scenarios; **Phase 2** H1 2027, a new Graph version requiring
`messaging_account_id` in multi-account setups plus a new `whatsapp_account` webhook topic; **Phase 3** H1
2028, endpoints taking a phone-number ID in the path must use WAAC IDs.

One hard date sits inside that: **migrate `paid_messaging_account_id` → `messaging_account_id` by
2026-12-31.** **Checked: this repository uses neither identifier** (`git grep` finds no occurrence of
`paid_messaging_account_id`, `messaging_account_id` or `waac`), so there is nothing to migrate and the
2026-12-31 date does not bite. It is recorded because Phase 2 will, and because the Embedded Signup
session-info field names under the new model are *not* yet published — the new-model field list is given
only for message events (`waba_id`, `cs_id`, and `waac_id` arriving at Phase 2). That gap is the one thing
in this area worth its own pass before Phase 2.

This page is explicitly beta: *"All information described in this document is subject to change."*

### Webhook subscription and the field-list that may not exist

The edge is `subscribed_apps` on the WABA node, same path for all three methods:
`POST`/`GET`/`DELETE /{Version}/{WABA-ID}/subscribed_apps`. A subscription is verified by `GET` on the same
edge; there is no separate verify call. The reference documents exactly two optional `POST` body params,
`override_callback_uri` and `verify_token`, and **no per-field parameter** — individual webhook fields are
chosen in the App Dashboard. **Checked: this repository sends no `subscribed_fields`**, so it does not rely
on a parameter Meta's reference does not document.

### `display_phone_number`: two surfaces, two formats, and the normative wording

This is the one documentation finding that changed an implementation decision in this commit, and it is the
evidence behind the echo repair.

Meta does **not** anywhere state that `display_phone_number` is "display only", nor forbid using it as an
identifier. The strongest normative wording is in the `GET /{Version}/{WABA-ID}/phone_numbers` schema, where
the field is **required**: *"Phone number in international format for display purposes."* The webhook
reference gives the field **no description at all** — it appears only in examples.

The formats differ, demonstrably, in Meta's own examples:

| Surface | Literal example | Format |
|---|---|---|
| Webhook `metadata` | `"display_phone_number": "15550783881"` | bare digits, no `+`, no separators |
| `/phone_numbers` Graph edge | `"+1 631-555-5555"` | leading `+`, spaces and hyphens |

`messages[].from` and `contacts[].wa_id` are bare digits (`"16505551234"`). So comparing `from` to
`display_phone_number` by raw string equality is correct **only** for the webhook spelling, and this product
reads the punctuated spelling too: onboarding stores it from the `/phone_numbers` edge, and the repository's
own fixtures carry `"+1 555 0100"` read from there.

That is why coexistence echo detection now compares a canonical digits-only value (`sameNumber` in
`packages/channel-whatsapp/src/normalize.ts`) rather than the raw strings, and refuses to call two spellings
with no digits a match. The identity and idempotency keys were checked and are unaffected: tenancy keys off
`phone_number_id`, dedupe keys off `wamid`, and **no unique index includes `display_phone_number`**.

### Provider vocabularies disagree with themselves, which the implementation survives

Two fields carry **contradictory enumerations across sibling Meta reference pages today**:

- `code_verification_status` — `EXPIRED | NOT_VERIFIED | VERIFIED` on one page, `VERIFIED | UNVERIFIED` on
  another;
- `quality_rating` — `GREEN | YELLOW | RED | UNKNOWN` on one page, `GREEN | YELLOW | RED | NA` on another,
  while an older guide shows `GREEN`, `NA` and `UNKNOWN` in examples.

A narrow TypeScript union or a CHECK constraint over either field would therefore fail on a value Meta
itself documents elsewhere. **Checked: both are typed as plain `string` end to end** — in `PhoneNumberAsset`,
in the onboarding store, and in the database column — and health is derived by a single case-insensitive
comparison against one flagged value. The existing test says why in its own name: *"reads the rating
case-insensitively, because it is the provider's vocabulary."* Nothing to change; recorded so a future
tightening of those types is recognised as a regression rather than an improvement.

The register reference also states *"The phone number must be in UNVERIFIED status to register"*, which
conflicts with the request-code → verify-code → register ordering and appears to conflate
`code_verification_status` with `status`. Not encoded as a precondition anywhere here, and it should not be
until a second primary source agrees.

### Where the documentation now lives

Meta's authoritative pages have moved to
`https://developers.facebook.com/documentation/business-messaging/whatsapp/…`; the old `/docs/whatsapp/`
paths still resolve by redirect but are no longer canonical. Every page now has a machine-readable `.md`
twin, with an index at `…/whatsapp/llms.txt`, and the `.md` form is the reliable one to fetch.
`…/embedded-signup.md` is **not** a valid path — the entry point is `…/embedded-signup/overview.md`.

### Coexistence, and where the documented echo actually arrives

Coexistence is now a first-class, documented Embedded Signup path — *"Onboard Business app users
(Coexistence)"* in Meta's own documentation index — carrying no beta or public-preview label. It lets a
Solution Partner or Tech Provider onboard a number **already registered on the WhatsApp Business app** to
Cloud API; the business keeps sending 1:1 from the app while the partner sends at scale through Cloud API.

Gating is heavy, and all of it is provider-side rather than anything the UI may promise in advance:
WhatsApp Business app **2.24.17 or higher**; Solution Partner or Tech Provider status; **Embedded Signup
with session logging**; and a webhook endpoint that reliably accepts and processes webhooks. After
onboarding there are **24 hours** to synchronise contacts and messaging history, and **each sync may be run
only once per onboarding** — miss it and the business must offboard and repeat the flow. History reaches
back **180 days**, group chats excluded, with media asset IDs only for media from the **14 days after**
onboarding. A number used with both apps has a fixed throughput of **20 mps**. Up to **four** companion
clients are supported, and all are unlinked at onboarding.

**The finding that matters for this commit.** Meta documents app-sent and companion-device messages under a
webhook field of their own:

- field: `"field": "smb_message_echoes"` inside `entry[].changes[]`;
- payload: `entry[].changes[].value.message_echoes[]` — note the field name and the array name differ;
- each item: `from`, `to`, `id`, `timestamp`, `type`, plus one property named after the `type`;
- `type` ∈ `text | image | video | document | revoke | edit` — **no `audio`, `sticker`, `location`,
  `contacts` or `reaction`**, so an app-sent voice note is not in the documented echo type list;
- `revoke` carries `original_message_id`; `edit` carries `original_message_id` and a nested `message`.

And authorship under the new model is **field-scoped, not value-scoped**. Meta documents three separate
mechanisms:

1. app-sent / companion-sent live messages → `smb_message_echoes`; *arrival under that field is itself the
   identification*, not an inference from `from`;
2. messages this product sent through Cloud API → the `messages` field's `statuses[]` array, correlated by
   the `id` the send call returned. Meta is explicit that these *"don't describe the contents of the
   outgoing message itself, only its status"*;
3. the onboarding history backfill → the `history` field, which **is** direction-by-value: *"If the value is
   the business's phone number, the message object describes a message sent by the business to a WhatsApp
   user."*

So the `from`-equals-`display_phone_number` branch in `normalize.ts` is a **belt-and-braces path, not the
documented coexistence mechanism**. Stated precisely, because the distinction is easy to overstate: Meta
documents the echo under its own field and documents `messages[]` as carrying inbound user messages, but it
does not anywhere say in so many words that an echo can never appear in `messages[]`. The honest reading is
that the documented route is `smb_message_echoes` and this branch covers a shape Meta does not describe.

At this head the adapter skips every change whose `field` is not `messages`, recording
`whatsapp.unhandled_field` rather than pretending otherwise — so a real coexistence echo is currently
**logged and dropped here**, and consuming `smb_message_echoes` belongs to the later coexistence task in
this chain. That is why this commit **hardens** the existing comparison rather than replacing it: the repair
is correct on its own terms, costs nothing, and removes a format trap that would otherwise be inherited by
whatever consumes echoes next — where `message_echoes[].from` is documented as the business *display* phone
number, which is exactly the spelling problem again.

One documentation gap worth knowing: Meta's index lists a "Message echoes" guide at
`…/webhooks/message_echoes.md`, and that URL returns **Page Not Found** (the `/docs/` form 404s too). The
reference material above comes from the webhook reference pages, not from that guide.

### The 24-hour window and `131047`: confirmed unchanged

*"When a WhatsApp user messages you or calls you, a 24-hour timer called a customer service window starts."*
*"If the user messages or calls you again before the timer expires, the timer resets to 24 hours."* While it
is open, the listed service message types may be sent; *"When the window closes, you can only send
pre-approved template messages."* Note the direction of that sentence: Meta does not say templates may be
sent at any time — it says non-templates require an open window. `131047` remains the code for sending
outside it, with "send a template instead" as the documented remedy.

Two cautions recorded: `131047` has **no documented title** on Meta's error-codes page, so any code keying
off a human-readable title rather than the numeric code would be keying off a value Meta does not publish —
this adapter keys off the number. And the coexistence **supported-country list could not be read** from any
primary page; treat eligibility as provider-reported, which is what the architecture already does.

### Dated items landing between 2026-10 and 2027-12

| Date | Item |
|---|---|
| **2026-10-15** | Embedded Signup v2 deprecation — stated date, **passed, enforcement unconfirmed** |
| **2026-12-31** | `paid_messaging_account_id` → `messaging_account_id`; also: Indian customers must have all WABAs on INR |
| **2027-01-01** | Meta stops delivering messages from non-INR WABAs of eligible Indian customers |
| **2027-01-21** | Graph API `v21.0` expires |
| **2027-05-20** | Graph API `v22.0` expires |
| **2027-06-30** | Brazilian customers must have all WABAs on BRL |
| **2027-07-01** | Meta stops delivering messages from non-BRL WABAs |
| **2027-10-08** | Graph API `v23.0` expires |

None of these retires a webhook field or a send endpoint. The expiry rule is stated verbatim: *"A version
will no longer be usable two years after the date that the subsequent version is released."*

One **version-gated** change, not date-gated, that would be easy to miss: from Graph API **v24.0 onward the
`statuses` webhook no longer includes the `conversation` object**, except for messages sent during an open
Free Entry Point window. This product defaults to v26.0, so it is already past that line — **checked: the
adapter reads neither `conversation` nor `pricing` from a status**, so nothing depended on it.

Already past, for completeness: On-Premises API's final client expired 2025-10-23, the On-Behalf-Of model
closed to new onboarding 2025-09-29, and the 2026-10-01 rate-card update has taken effect.

### Sources read on 2026-10-15 and 2026-10-16

- `…/whatsapp/embedded-signup/versions/` and `…/versions.md`, `…/version-4.md`,
  `…/version-4-public-preview.md`, `…/version-3.md`, `…/embedded-signup/overview.md`
- `https://developers.facebook.com/blog/post/2026/05/14/embedded-signup-v4/`
- `https://developers.facebook.com/docs/graph-api/changelog/versions`
- `…/whatsapp/account-model-evolution.md`, `…/account-model-evolution/onboarding.md`,
  `…/account-model-evolution/messaging.md`
- `…/whatsapp/changelog.md`, `…/whatsapp/webhooks/payload-examples`, `…/whatsapp/webhooks/overview/`
- the `subscribed_apps`, `phone_numbers` and `register` reference pages, and the permissions page

No production Meta credential, token or app secret was used for any of this; every provider response in the
suite remains a fixture.
