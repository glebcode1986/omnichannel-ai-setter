# ADR-016: Configurable WhatsApp after-window policy options

**Status:** Proposed — product-owner decision still open

## Platform fact

The current WhatsApp customer-service window allows supported free-form customer-care replies after a customer message for the platform-defined window (currently 24 hours). Outside that window, arbitrary free-form AI continuation is not the supported route; approved message templates are the relevant provider mechanism.

## Proposed product options

Design `AutomationPolicy` so the product can support both of the following without schema redesign:

1. `SERVICE_WINDOW_ONLY`
   - when free-form service window closes, conversational AI delivery stops;
   - AI may keep a draft/internal recommendation but does not send an outside-window template automatically;
   - customer messaging again reopens the normal service flow.

2. `TEMPLATE_ASSISTED`
   - when window is template-only, the system may identify an eligible approved template and prepare validated variable values;
   - a separate configuration determines whether an eligible template requires human approval or may be auto-scheduled under explicit business policy/consent;
   - the LLM cannot invent an unapproved template or rewrite approved provider text arbitrarily.

## Not decided yet

The product owner has not yet chosen:

- whether both modes ship in MVP;
- default mode;
- whether `TEMPLATE_ASSISTED` can auto-send or must initially be human-approved;
- which template categories/use cases should ever be eligible for automation.

Until decided, implementation must not silently default to aggressive outside-window template automation.

## Required invariants regardless of choice

- current template status/language/category is checked;
- provider/user opt-in and current WhatsApp policy remain authoritative;
- deterministic policy, not model preference, decides eligibility;
- template parameters are validated against the approved template shape;
- unsubscribe/stop signals and account-health restrictions override automation;
- audit trail records why/which template was selected and who/what authorized send.
