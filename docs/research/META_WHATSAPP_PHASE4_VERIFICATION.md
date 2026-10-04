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
