# Meta Instagram Phase 2 Verification — 2026-09-16

This file records external platform facts used by Phase 2 architecture. Re-verify before shipping because Meta APIs/policies change.

## Instagram Login

Meta's official Instagram Postman collection states that Instagram API with Instagram Login supports professional Business/Creator accounts and does not require a linked Facebook Page. Current scope names include `instagram_business_basic` and `instagram_business_manage_messages`.

Sources:
- https://www.postman.com/meta/instagram/folder/6raa77c/instagram-api-with-instagram-login
- https://www.postman.com/meta/instagram/documentation/23987686-9386f468-7714-490f-9bfc-9442db5c8f00

## User-initiated messaging

Meta's official Send API documentation states that the recipient must first have sent a message to the Instagram professional account; conversations begin from Instagram user activity rather than arbitrary business cold DMs.

Source:
- https://www.postman.com/meta/instagram/folder/uxudqu0/send-api

## Human Agent capability

Meta's current official Instagram Postman Send API collection includes a request named `Send a message with HUMAN_AGENT tag`, confirming the transport capability exists in the current API surface.

Sources/references:
- https://www.postman.com/meta/instagram/folder/uxudqu0/send-api
- Meta Human Agent feature documentation must be re-verified directly during implementation/App Review.

The current 2026 documentation ecosystem consistently describes Human Agent as a human-support exception after the standard window, typically up to 7 days from the user's message and gated by App Review/business verification. Because exact policy text can change, duration/eligibility is not a domain constant and must be implementation-time verified.

## Product conclusion chosen by owner

Expose two configurable modes:

- `STANDARD_ONLY`: no send after the normal automated window.
- `HUMAN_ASSISTED_EXTENDED`: after the normal automated window, AI may draft and queue for human review; if Human Agent eligibility/approval still passes, a real human action may send with the HUMAN_AGENT tag.

Do not implement a background AI worker that automatically attaches HUMAN_AGENT simply to masquerade as a human reply.
