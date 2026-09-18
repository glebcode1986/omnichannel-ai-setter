# Meta Instagram Phase 2 Verification — 2026-09-16, re-verified 2026-09-17

This file records external platform facts used by Phase 2 architecture. Re-verify before shipping because Meta APIs/policies change.

**Re-verification status (2026-09-17, during P2-01 / Issue #8).** Everything below under "Instagram Login", "User-initiated messaging" and "Human Agent capability" is **unchanged and confirmed**. The sections after them are new: the transport facts the adapter encodes, and six places where the platform differs from what this repository previously assumed.

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

## Transport facts encoded by the adapter (verified 2026-09-17)

- **Host and version.** Instagram API with Instagram Login is served from `graph.instagram.com`; a text send is `POST https://graph.instagram.com/<version>/<IG_ID>/messages`. The current Graph API version is **v26.0** (released 2026-07-29). Versions are supported for two years, so the version is adapter configuration, never a domain constant.
- **Scopes.** `instagram_business_basic` + `instagram_business_manage_messages`, with no linked Facebook Page. Advanced Access needs App Review plus Business Verification.
- **Webhook verification.** GET handshake with `hub.mode=subscribe` / `hub.verify_token` / `hub.challenge`; payloads are signed with `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the raw body with the app secret>`. Meta calls payload validation optional; we always require it, and we verify the raw bytes because re-serializing JSON breaks the digest.
- **Send result.** Success returns `{"recipient_id": "...", "message_id": "..."}`. Message text must be UTF-8 and at most **1000 bytes**.
- **No idempotency key.** Neither the Instagram nor the Messenger Send API documents an idempotency key or request token. A timeout after dispatch is therefore genuinely ambiguous, which is exactly the situation ADR-012 is written for.
- **Transport failures are indistinguishable.** Node's `fetch` rejects with a `TypeError` for every transport failure — refused connection, DNS failure, a socket reset after the request body was written, even a body read that fails after a `200`. Nothing in the error says whether Meta received the message, so the adapter treats every transport failure except an unparsable URL as ambiguous, and a `5xx` as ambiguous regardless of what its body claims about transience.
- **Errors.** `{"error": {message, type, code, error_subcode, fbtrace_id, is_transient}}`. Window, permission, policy and recipient-state errors (10, 100, 190, 200, 551, 2022) are final; throttling and transient platform errors (2, 4, 613, 2018300, 2018321) may be retried. Unknown codes are treated as final unless Meta marks them transient.
- **Rate limits.** 300 calls/second per professional account for text, far above realistic load; throttling surfaces through `X-App-Usage` / `X-Business-Use-Case-Usage` and the codes above.
- **Standard window.** 24 hours from the person's last message. It is opened or reset by the person messaging, tapping a CTA, clicking a click-to-Instagram ad or an ig.me link, reacting to a message, or commenting on a post.
- **Human Agent.** 7 days from the person's message, for human support only, gated by App Review (App dashboard → App review → Permissions & Features → Human Agent). On `graph.instagram.com` it is sent as a **top-level `"tag": "HUMAN_AGENT"` field with no `messaging_type`** (Messenger requires `messaging_type`; Instagram does not). Meta's policy names "automated messages" and "content unrelated to the user inquiry" as disallowed usages. The 2026-04-27 removal of several message tags did **not** include HUMAN_AGENT.

## OAuth and token lifecycle (verified 2026-09-17, during P2-02)

The login flow spans **three hosts**, which is the single easiest thing to get wrong:

| Step | Request |
| --- | --- |
| Authorize | `GET https://www.instagram.com/oauth/authorize` with `client_id`, `redirect_uri`, `response_type=code`, `scope`, `state`, and optionally `force_reauth` |
| Exchange code | `POST https://api.instagram.com/oauth/access_token`, form-encoded, with `client_id`, `client_secret`, `grant_type=authorization_code`, `redirect_uri`, `code` |
| Long-lived token | `GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=…&access_token=…` |
| Refresh | `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=…` |
| Identity | `GET https://graph.instagram.com/<version>/me?fields=id,user_id,username,name,account_type` |

- Meta's older reference page still documents `api.instagram.com/oauth/authorize` and the scope `instagram_basic`. That is **Basic Display API residue** and does not serve this flow; the business-login page is authoritative.
- The exchange response is **wrapped in a `data` array**: `{"data":[{"access_token":…,"user_id":…,"permissions":…}]}`. Code written against a flat body silently reads `undefined`.
- `permissions` is the **authoritative list of what the person actually granted**; they may deselect a permission on the consent screen and still return a valid code.
- The authorization code is valid for **one hour and single-use**, and Meta appends `#_` to the redirect, which is not part of the code.
- Business-login tokens are **short-lived (1 hour)**; the long-lived token lasts **60 days**. A refresh requires the token to be **at least 24 hours old and not yet expired** — so a token minted seconds ago cannot be refreshed, and one not refreshed within 60 days can only be replaced by a new login.
- `me` returns **both** `id` (app-scoped) and `user_id` (the professional account ID used by `/<IG_ID>/messages`). Persisting `id` produces an onboarding that appears to work and then fails every send.
- The token endpoint reports errors in a **flat** envelope — `{"error_type":…,"code":…,"error_message":…}` — unlike every `graph.instagram.com` endpoint, which uses the nested `{"error":{…}}` shape.
- A denied authorization redirects with `error=access_denied&error_reason=user_denied&error_description=…`. That text is Meta-authored and untrusted; it is never reflected into a page or a URL.
- **Human Agent approval is not discoverable through any API** on this path. Meta documents the feature and its App Review requirement but exposes no status endpoint, so approval is operator-entered configuration that defaults to "unknown" (which keeps the tagged send path closed).
- Token invalidation surfaces as code `190` with subcodes such as 458 (app removed), 460 (password changed), 463 (expired) and 467 (invalid), and as codes 10 / 200–299 when a permission was revoked.

## Divergences from this repository's earlier assumptions (2026-09-17)

1. **Instagram has no delivery webhook at all.** `message_deliveries` and `message_reads` are Messenger-only; Instagram reports reads as `messaging_seen`. An Instagram adapter that never emits `DELIVERY_STATUS` is therefore conformant, not incomplete.
2. **`messaging_policy_enforcement` is unavailable** on the Instagram-Login configuration, so there is no webhook source for `CONVERSATION_POLICY` events on this path.
3. **There is no `message_deletions` field.** A deletion arrives on the ordinary `messages` field as `message.is_deleted: true`; media Meta cannot hand over arrives as `is_unsupported: true`; echoes as `is_echo: true`. `is_self: true` marks test messages to your own account and must not be confused with `is_echo`.
4. **Webhook items carry no event identifier.** Instagram-Login deliveries use `entry[].messaging[]`, batch up to 1000 updates, and Meta retries for 36 hours while stating that the receiver must deduplicate. The adapter therefore synthesizes a deterministic `sourceEventId` from payload fields only.
5. **Instagram echoes carry no `app_id`** (Messenger's `message_echoes` does). Correlating our own sends by platform message ID, as ADR-013 requires, is the only workable classification — now a platform constraint, not just a design preference.
6. **New since the 2026-09-16 baseline:** a `message_edit` webhook subscription (added 2025-09-10), and Meta ended Handover Protocol support for Instagram on 2025-10-23 in favour of Conversation Routing. The normalized contract has no edit variant, so we do not subscribe to it; thread ownership is not modelled on Handover semantics.

## Automated response timing — owner decision applied

Meta's Messenger Platform and Instagram Messaging policy requires experiences classified as **automated** to respond to user-initiated input within **30 seconds**, with messaging restrictions after a remediation window; hybrid and human-led experiences are declared as such at App Review.

The product owner resolved the resulting tension with the generic 7–12 s debounce and 30–120 s delivery delay (PR #63, 2026-09-17): **provider timing wins.** For Instagram, debounce + generation + any artificial delay must fit inside the verified budget, the operational target is ~25 s from the triggering inbound, artificial delay is shortened or dropped as needed, and a missed deadline means hold/review rather than sending late as ordinary AUTOPILOT. The adapter therefore exposes the budget and target as configuration (`instagramTimingPolicy`), and the delivery coordinator (P2-06) makes the scheduling decision. The number is not a domain constant: re-verify it at App Review and before production, and change the configuration if Meta's rule changes.

## Pages that could not be read on 2026-09-17

`/docs/instagram-platform/reference/instagram-api/messages` returned 404, the Send API reference rendered as an empty shell, and the Messenger changelog returned HTTP 500. The canonical Send API parameter reference was therefore **not** read directly; the HUMAN_AGENT wire format above comes from Meta's official Instagram Postman collection (updated 2026-08-25) and must be confirmed against a live call during P2-02 / App Review.
