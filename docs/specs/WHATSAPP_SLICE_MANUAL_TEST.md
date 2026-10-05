# WhatsApp vertical slice — sandbox test plan (P4-07)

The automated suite proves the path with a scripted Meta endpoint and a fixture model. This plan covers
what only a real WhatsApp Business account can show: that the wire format, the signature, the
customer-service window and the coexistence webhooks are what we believe they are.

**Nothing here is required for CI.** Every automated test runs with no production credential, and the
suite that drives this slice (`apps/worker/src/whatsapp-slice.integration.test.ts`) uses a fake phone
number, a fake messaging account and a fake token throughout.

## Before starting

A Meta app with WhatsApp added, a test phone number or a real number you are willing to onboard, and a
public HTTPS callback. Configure `WHATSAPP_APP_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`,
`WHATSAPP_SIGNUP_CONFIG_ID`, `CHANNEL_CREDENTIAL_KEY_ID`, `CHANNEL_CREDENTIAL_KEY` and
`ANTHROPIC_API_KEY`. The worker needs `WHATSAPP_APP_SECRET` and `WHATSAPP_VERIFY_TOKEN` too — without
both it configures no WhatsApp transport and every send is refused with `NO_ADAPTER`.

Subscribe the app to `messages` at minimum. For the coexistence steps also subscribe to
`smb_message_echoes`, `account_update`, `history` and `smb_app_state_sync`, and to
`message_template_status_update` for the template steps.

Start with the Business Profile in **DRAFT** mode. Do not begin at AUTOPILOT.

## 1. Onboarding

Run Embedded Signup from the dashboard. Confirm a `whatsapp_connections` row exists with `connected_at`,
`phone_registered_at` and `webhook_subscribed_at` set, and that `onboarding_mode` matches how you
onboarded — `COEXISTENCE_EXISTING_BUSINESS_APP` only if you used a number already on the WhatsApp Business
App. The access token must not appear in any log line.

**Check the capability that follows from it.** `channel_accounts.capabilities.nativeOutboundVisible` should
be `true` for a coexistence number and `false` otherwise. On the Channels page a `false` account shows the
"replies sent from the provider's own app are not visible here" caveat. That sentence is the product
stating a limitation rather than guessing authorship, so it is worth reading on screen at least once.

## 2. Inbound arrives and is scoped

Message the business number from a personal WhatsApp account. Expect a `messages` row with
`direction = IN`, an `inbound_events` row and a debounce job. Check the conversation belongs to the right
Business Profile, and that `metadata.phone_number_id` in the payload matches the account the route
resolved — a mismatch should be refused, not stored.

## 3. DRAFT mode holds

With the profile in DRAFT, send another message. A draft should appear in Review and **nothing** should
leave. Confirm no `delivery_jobs` row reaches `SENT`.

## 4. AUTOPILOT inside the window

Switch to AUTOPILOT and message again. Expect a reply after the configured delay, a `delivery_jobs` row
with `status = SENT` and a `platform_message_id` that starts `wamid.`, and a `messages` row with
`direction = OUT`, `source = AI` and the same `operation_id`.

Check the delay you actually waited. It should be inside the configured range and **not** shortened —
Instagram's automated-dispatch budget does not apply to WhatsApp, and if replies arrive suspiciously fast
that rule has leaked across channels.

## 5. Presence, if it is switched on

Set presence to "mark read and show typing" in AI Settings. Send a message and watch the phone: the
message should be marked read and the typing indicator should appear **shortly before** the reply, not at
the start of the delay. Meta dismisses the indicator after 25 seconds, so an indicator that appears and
vanishes well before the reply means the lead is wrong.

## 6. Outside the window

Wait more than 24 hours after the customer's last message, or use a conversation that has gone quiet, then
trigger a draft. With ADR-016's default (`SERVICE_WINDOW_ONLY`) automation must stop and the draft must be
held for a person. Confirm no free-form send is attempted — Meta would refuse it with error 131047, and
seeing that error means a gate failed rather than the platform.

## 7. Newer inbound supersedes

Message the business, wait for the reply to be scheduled, then message again before it goes out. The
scheduled delivery must settle `CANCELLED_SUPERSEDED` and nothing should be sent for the first message.

## 8. Coexistence: a native reply pauses automation

**Only on a coexistence number.** Reply to the customer from the WhatsApp Business App on the phone.
Expect an `smb_message_echoes` webhook, a `messages` row with `direction = OUT` and `source = HUMAN`, and
the conversation moving to `HUMAN_ACTIVE` with `takeover_reason = UNMATCHED_OUTBOUND_ECHO`. Any draft
pending for that conversation must stop.

Then hand back from the Inbox and confirm automation resumes.

## 9. Our own reply does not trigger a takeover

Let the assistant reply on a coexistence number. If an echo arrives for that message, the conversation
must stay `NONE` — the message id matches our own send, so it is correlated as ours. A takeover here is
the bug this step exists to catch.

## 10. Disconnect and reconnect

In the WhatsApp Business App: **Settings → Account → Business Platform → Disconnect**. Expect an
`account_update` webhook, the channel account moving to `NEEDS_REAUTH` and the connection carrying
`health_reason = COEXISTENCE_OFFBOARDED`. Any scheduled reply must be held rather than sent.

Re-register or reconnect in the app and confirm an `ACCOUNT_RECONNECTED` event returns the account to
`CONNECTED` and clears the reason.

## 11. A voice note

Send a voice note. Expect a `message_transcripts` row, `PENDING` first and then `READY` with the words,
the provider and the model — and with `confidence` **null**, because `gpt-transcribe` publishes none.
The reply should answer what was said.

Then send an unreadable recording, or switch `OPENAI_API_KEY` off, and confirm the transcript row records
a reason, the draft is held, and its reason codes contain `AUDIO_NOT_TRANSCRIBED`. No invented reply.

## 12. Provider rejection and ambiguity

Force a rejection — message a number that has not opted in, or let the window close — and confirm the
delivery records the provider's code without retrying. For ambiguity, interrupt the network mid-send if
you can: the delivery must settle `HELD_AMBIGUOUS` and **never** be retried automatically.

## 13. Duplicates and reordering

Replay a webhook delivery (Meta retries for seven days, or resend it yourself). Confirm `inbound_events`
counts one, no second message row appears, and no second reply goes out. Deliver a `read` status before
its `delivered` and confirm the stored status does not move backwards.

## What to check in the logs throughout

No access token, no `wamid` of a customer's message, no customer text and no transcript words. Identifiers,
provider error codes and counts only.
