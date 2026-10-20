# WhatsApp Onboarding — Embedded Signup Specification

**Status:** Implemented in `packages/channel-whatsapp` (provider calls), `packages/db` (persistence) and
`apps/web/src/server/whatsapp-onboarding.ts` (the flow) — P4-02 / Issue #19, 2026-10-04. Meta's Embedded
Signup process, scopes and deadlines were re-verified the same day; see the Issue #19 section of
`docs/research/META_WHATSAPP_PHASE4_VERIFICATION.md`.

## Implementation-time decisions

These are decisions the architecture above left open, recorded where the next reader will look for them.

**Embedded Signup v4 only.** Versions 2 and 3, including their public previews, are deprecated on
2026-10-15. There is no compatibility path worth building for a flow that stops working.

**The exchangeable code is never persisted.** Meta gives it a 30-second life, so the exchange happens in
the request that receives it; an expiry is a refusal the operator resumes from, not background work.

**The two-step verification PIN is not stored.** It is used once, for `POST /<phone_number_id>/register`,
and keeping it would add a second secret at rest for a value the operator already has. The operator
supplies it when they connect, and nothing logs, returns or persists it.

**The browser is believed about nothing.** `phone_number_id` is looked up *on* the `waba_id` with the
exchanged token, and the token is checked against this app with `debug_token`. A pair that does not belong
together is refused; so is a token minted for another application.

**A failed provider step persists nothing at all.** Webhook subscription and — outside coexistence — phone
registration must both succeed before any row is written, so there is no half-connected account to repair.
Both calls are idempotent, so retrying costs nothing.

**`connected_at` is the claim, and the database checks it.** CHECK constraints refuse a connected
connection whose webhook subscription is missing, and — outside
`COEXISTENCE_EXISTING_BUSINESS_APP` — one whose phone registration is missing. The coexistence exemption
is written out in the constraint rather than implied in code.

**`DEGRADED` means the provider flagged the number**, specifically a red quality rating. The credential and
the assets are fine, so a person may still approve a reply; the policy engine holds every *unattended* one
(`ACCOUNT_UNHEALTHY`). A template catalogue this deployment could not read is deliberately **not**
degradation: free-form care is unaffected, the transport refuses a template send naming a template it
cannot find, and delivery policy rechecks template status anyway.

**Completion is a same-origin POST**, not a provider redirect, because Embedded Signup hands its result to
our own page through Meta's JavaScript SDK. The state cookie is therefore `SameSite=Strict`, and nothing
Meta sends ever reaches the browser as markup or as a redirect target.

## Goal

Allow a workspace owner/admin to connect an eligible WhatsApp Business account/phone number to the SaaS through Meta's official Embedded Signup path without sharing WhatsApp passwords or using QR/session scraping.

## Onboarding model

The product acts as a Meta app/SaaS integration and stores only the provider asset IDs and credential references necessary for authorized Cloud API access.

Conceptual flow:

1. workspace owner starts `Connect WhatsApp`;
2. server creates signed onboarding state bound to workspace/user/session;
3. client launches current Meta Embedded Signup flow over HTTPS;
4. callback/result returns provider-authorized business/WABA/phone assets;
5. server validates state, selected business assets and current permissions;
6. assign/add required system-user access where applicable;
7. register/verify selected phone number when required by the current flow;
8. subscribe app to WABA webhooks;
9. fetch/verify phone-number identity, quality/status and templates;
10. persist encrypted credential reference + provider asset IDs/capabilities;
11. mark channel account connected only after required verification/subscription succeeds.

## Authorization/security

- state/CSRF binding is mandatory;
- only `OWNER`/authorized `ADMIN` may connect/disconnect a WhatsApp channel;
- callback cannot select a workspace solely from a query parameter supplied by the browser;
- access/system-user tokens are never logged or returned to client after exchange;
- secrets are stored through the repository credential/encryption abstraction;
- disconnect/revoke removes usable credentials and stops background sends;
- webhook routing resolves a configured provider asset to exactly one authorized `ChannelAccount`.

## Provider assets to retain

Keep channel-provider metadata flexible enough for Meta's evolving account model. Current useful identifiers include:

- business/portfolio ID where needed for management;
- WABA / current WhatsApp account identifier;
- phone-number ID;
- display phone number;
- verified/display business name/status;
- quality/account health signals;
- webhook subscription status;
- template sync cursor/status metadata;
- onboarding/coexistence mode/capability metadata when proven by Meta.

Do not treat display phone number as the sole stable provider key.

## Phone registration

Current Meta documentation requires Cloud API phone registration and two-step verification/PIN in relevant onboarding flows, with a current time limit after Embedded Signup. Treat exact registration deadline/PIN workflow as implementation-time provider rules, not timeless domain constants.

## Existing WhatsApp Business App / coexistence

The connection UX should support two conceptual paths where Meta currently permits them:

- `NEW_OR_MIGRATED_CLOUD_NUMBER`
- `COEXISTENCE_EXISTING_BUSINESS_APP`

But `COEXISTENCE_EXISTING_BUSINESS_APP` is capability-gated. UI must not promise availability before Embedded Signup/current Meta eligibility confirms it. If coexistence is not eligible, provide a clear provider-derived explanation and supported alternative.

When coexistence is active, native human sends observed through supported Meta events must feed human takeover; the bot must not fight with the person using the phone app.

## Template bootstrap

After connection, sync the current approved/pending/rejected template catalog for the selected business account. Template identity includes provider template ID/name, language, category, components, status and last-synced timestamp/version metadata.

Do not consider a cached template eligible forever; delivery policy rechecks current enough status according to sync/error policy.

## Reconnect/reauth/disconnect

Connection state should distinguish at least:

- `CONNECTED`
- `DEGRADED`
- `REAUTH_REQUIRED`
- `DISCONNECTED`

Token/permission/asset failures update account health and prevent unattended sends until safe. Reconnect should preserve conversation/audit history rather than create a new logical tenant accidentally.

## Tests

- valid Embedded Signup completion;
- state/CSRF mismatch;
- user lacks workspace permission;
- partial onboarding failure after asset selection;
- webhook subscription failure;
- phone registration failure/expiry;
- missing messaging/management permission;
- duplicate/replayed callback;
- same provider phone attempted in two unauthorized workspaces;
- reconnect and disconnect;
- coexistence eligible vs unavailable fixture;
- secret redaction in logs/errors.
