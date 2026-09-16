# ADR-015: Use official WhatsApp Embedded Signup for SaaS onboarding

**Status:** Accepted

## Decision

For production SaaS onboarding, connect WhatsApp Business customers through Meta's current official Embedded Signup / Business Platform flow and official Cloud API assets. Do not ask users for WhatsApp passwords, browser session cookies, QR automation sessions or unofficial WhatsApp Web credentials.

## Why

The product is intended to be a commercial multi-tenant SaaS. Official Embedded Signup provides the supported path to authorize client business assets, assign required access, register phone numbers and subscribe the app to WABA webhooks while preserving platform policy and auditability.

## Consequences

- `Connect WhatsApp` is a provider onboarding flow, not a QR scraper;
- channel account stores provider asset IDs and encrypted credential references;
- implementation must verify current required scopes/advanced access/business verification rules;
- webhook subscription and phone registration are explicit onboarding states;
- coexistence with an existing WhatsApp Business App number is capability-gated rather than universally assumed;
- if Meta's evolving account model changes asset relationships, update adapter/provider metadata without changing channel-neutral contact/conversation identity semantics.

## Non-goal

This ADR does not decide whether approved templates outside the 24-hour service window may auto-send; that is a separate product-policy decision.
