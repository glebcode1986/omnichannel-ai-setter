# Meta API Verification — 2026-09-16

This file records current platform constraints verified against Meta-maintained API references. Re-check before release because Meta can change permissions, policy windows and onboarding.

## Instagram

Current Meta Instagram API with Instagram Login supports professional accounts (Business/Creator) and includes the `instagram_business_manage_messages` permission.

The official Send API model is inbound-first: the Instagram user/customer must first message the professional account; the API is then used to send/receive within that conversation. Therefore arbitrary cold DM initiation to followers is **not** an MVP capability.

Architecture consequence:

- MVP onboarding should prefer Instagram API with Instagram Login rather than the older Facebook-Login path unless a Page-dependent feature is later required.
- The adapter must expose current conversation eligibility rather than letting the AI assume it can initiate a thread.
- Comment/story/mention entry points may create eligible conversations only when supported by current Meta rules; adapter policy remains authoritative.

## WhatsApp

Use official WhatsApp Business Platform Cloud API.

Current customer-service behavior: after a customer messages the business, a 24-hour customer-service window permits free-form replies. Outside that window, business-initiated outreach must use an approved message template where Meta policy requires it. The adapter/policy layer must track this state and choose/hold message types accordingly.

Architecture consequence:

- persist last qualifying inbound timestamp/window metadata;
- validate window immediately before send;
- model free-form and template messages as different outbound capabilities;
- expect both synchronous and asynchronous delivery failures and reconcile status webhooks.

## Threads

Current official Threads API references focus on publishing, reading/managing replies, insights, search and mentions. No supported private-DM send/read scope or endpoint was identified in the current Meta collection.

Decision: Threads private messaging is not an MVP channel. Re-evaluate when Meta exposes an official public messaging API.

## Normative source rule

Community repositories help with implementation patterns, but current Meta documentation/API behavior wins whenever upstream examples conflict with the platform.
