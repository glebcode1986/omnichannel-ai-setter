# ADR-006: Prefer Instagram API with Instagram Login

**Status:** Accepted for MVP

## Decision

Use the current Instagram API with Instagram Login path for MVP professional-account onboarding and messaging unless a required feature later forces the Facebook-Login/Page-linked path.

## Why

Current Meta API references expose professional-account messaging with `instagram_business_manage_messages` through Instagram Login, while the Facebook Login path carries an explicit Page-link requirement. Avoiding an unnecessary Page dependency simplifies onboarding.

## Product constraint

Official Instagram messaging is inbound-first: the recipient/customer must have initiated a conversation with the professional account before the API can reply. We do not design arbitrary cold-DM-to-followers as an MVP feature.

## Consequences

- onboarding UX asks for/validates a professional Instagram account;
- adapter reports conversation eligibility/capabilities;
- if ads/Page-dependent features become necessary, add a new ADR rather than silently switching auth paths.
