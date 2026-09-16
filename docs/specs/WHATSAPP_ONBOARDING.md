# WhatsApp Onboarding — Embedded Signup Specification

**Status:** Architecture prepared; current Meta onboarding must be re-verified at implementation time.

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
