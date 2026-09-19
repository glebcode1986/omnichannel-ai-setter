# Instagram vertical slice — sandbox test plan (P2-09)

The automated suite proves the path with a fake Meta endpoint and a fixture model. This plan covers what
only a real Meta test account can show: that the wire format, the signature and the windows are what we
believe they are.

**Nothing here is required for CI.** Every automated test runs with no production credential.

## Before starting

A Meta app in development mode, an Instagram professional account added as a tester, and a public HTTPS
callback. Configure `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `INSTAGRAM_VERIFY_TOKEN`,
`INSTAGRAM_REDIRECT_URI`, `CHANNEL_CREDENTIAL_KEY_ID`, `CHANNEL_CREDENTIAL_KEY` and `ANTHROPIC_API_KEY`.
Leave `INSTAGRAM_HUMAN_AGENT_APPROVAL` at `UNKNOWN` unless Meta has actually approved the app: the value is
evidence, not a preference, and `UNKNOWN` fails closed.

Start with the Business Profile in **DRAFT** mode. Do not begin at AUTOPILOT.

## 1. Onboarding and webhook handshake

Connect the account through the dashboard. Confirm the subscription handshake succeeds and that a stored
credential row exists with a non-null `expires_at`. The access token must not appear in any log line.

## 2. Inbound arrives and is scoped

Send a message from a second Instagram account. Expect a `messages` row with `direction = IN`, an
`inbound_events` row, and a debounce job. Check the conversation belongs to the right Business Profile.

## 3. DRAFT mode holds

Wait for the debounce window. Expect an `ai_drafts` row and a conversation in `REVIEW_REQUIRED`, and
**no** `delivery_jobs` row. Nothing should reach the customer.

## 4. Approve from the review queue

Approve the draft. Expect a `delivery_jobs` row with `selected_delay_ms = 0`, then `SENT`, then the reply
visible in Instagram. Confirm the outbound `messages` row has `transport_path = STANDARD`.

## 5. Own echo does not pause automation

After step 4, Meta echoes the message we sent. Confirm the conversation is **not** moved to
`HUMAN_ACTIVE`: the echo correlates to our own operation (ADR-013).

## 6. Native reply does pause it

Reply from the Instagram mobile app. Expect `takeover_state = HUMAN_ACTIVE` with reason
`UNMATCHED_OUTBOUND_ECHO` and **no actor** — we cannot know which person it was.

## 7. AUTOPILOT, timing and supersession

Switch to AUTOPILOT and send a new question. Watch the delay chosen in `selected_delay_ms`: it must be
inside the configured range **and** inside Instagram's automated budget measured from the customer's
message. Before it fires, send a second customer message; expect the pending delivery to end as
`CANCELLED_SUPERSEDED` with nothing sent.

## 8. Window behaviour

Leave a conversation untouched for longer than the standard window and trigger a draft. Under
`STANDARD_ONLY` expect a policy `SKIP` and no review item. Switch the profile to
`HUMAN_ASSISTED_EXTENDED` and repeat: with approval genuinely granted, expect a review item marked
`HUMAN_AGENT`; without it, expect no human-agent path at all.

**Re-verify Meta's current timing rule and Human Agent policy during App Review** and record what you
find. Both are configuration with verified defaults, not domain constants — if the number has changed,
change the configuration, not the semantics.

## 9. Failure paths

Revoke the token in the Meta dashboard and trigger a delivery. Expect a definite rejection held for review
with the provider's code, and no retry loop. Then restore it.

To see the ambiguous path, interrupt the worker between claim and response (for example with a network
block). Expect `HELD_AMBIGUOUS` and a reconciliation job — **never** a second attempt. Confirm by hand that
the customer received at most one message.

## What must never be observed

Two replies to one customer message. A send after a human replied. A send outside the messaging window. An
automated send carrying the `HUMAN_AGENT` tag. An access token in a log. Any of these is a blocker, not a
bug to file.
