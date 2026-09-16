# ADR-002: Official WhatsApp Cloud API for Production

**Status:** Accepted

## Decision

Production WhatsApp transport uses Meta WhatsApp Business Cloud API. Baileys, whatsapp-web.js, Puppeteer and QR-session automation are research references only, not production transports.

## Why

SaaS reliability, compliance, scaling, supportability and account safety require the supported business integration path.

## Consequences

- onboarding must support Meta/WABA configuration;
- templates and customer-service-window policy are first-class requirements;
- transport implementation must follow current official Meta contracts;
- no feature may require a persistent WhatsApp Web session.
