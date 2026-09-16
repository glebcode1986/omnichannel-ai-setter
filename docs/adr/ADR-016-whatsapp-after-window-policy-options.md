# ADR-016: Configurable WhatsApp after-window policy

**Status:** Accepted

## Platform fact

The current WhatsApp customer-service window allows supported free-form customer-care replies after a customer message for the platform-defined window (currently 24 hours). Outside that window, arbitrary free-form AI continuation is not the supported route; approved message templates are the relevant provider mechanism. Implementation must re-verify current Meta timing, template, consent and category rules before shipping.

## Product decision

Ship three account/workspace-selectable outside-window modes. After-window policy remains separate from `AiMode` (`OFF | DRAFT | AUTOPILOT`).

1. `SERVICE_WINDOW_ONLY`
   - free-form automation stops when the customer-service window closes;
   - AI may keep an internal draft/recommendation but does not send an outside-window template;
   - a new customer message reopens normal free-form service flow.

2. `TEMPLATE_REVIEW`
   - when the window is template-only, the system may identify an eligible current approved template and prepare validated variable values;
   - a real authorized workspace user must review/approve the selected template and variables before send;
   - final send revalidates template status, language, variables, consent/policy and account health.

3. `TEMPLATE_AUTOPILOT`
   - when the window is template-only, deterministic policy may select/schedule an eligible current approved template without per-message human approval;
   - only templates/use-cases explicitly enabled for automation by account/workspace configuration are eligible;
   - the LLM may classify/rank an eligible approved template but cannot invent a template, rewrite approved provider text arbitrarily, or override policy/consent;
   - final pre-send revalidation is mandatory and STOP/unsubscribe/account-health restrictions always win.

## Configuration rule

The product exposes all three modes. Do not silently infer a workspace's preferred mode. Onboarding/settings must make the mode an explicit account/workspace choice before outside-window automation is enabled. Existing/migrated accounts without a stored choice behave conservatively as `SERVICE_WINDOW_ONLY` until explicitly configured.

`TEMPLATE_AUTOPILOT` also requires an explicit automation allowlist/policy for eligible templates or template use-cases. An empty allowlist means no unattended outside-window template send.

## Required invariants

- only current provider-approved/eligible templates may send;
- current template status, language/category/components and provider policy are checked;
- provider/user opt-in and current WhatsApp policy remain authoritative;
- deterministic policy, not model preference, decides eligibility;
- template parameters are runtime-validated against the approved template shape;
- unsubscribe/STOP signals, legal/compliance restrictions and account-health restrictions override automation;
- every outside-window send records mode, template/version/language, variables, selection reason and authorizing actor/system policy;
- provider ambiguity is quarantined and never blindly retried.

## Consequences

- `AutomationPolicy` gains a WhatsApp after-window mode: `SERVICE_WINDOW_ONLY | TEMPLATE_REVIEW | TEMPLATE_AUTOPILOT`;
- template automation allowlist/config is stored separately from the generic AI mode;
- shared policy engine must return review vs schedule distinctly;
- dashboard/onboarding must expose the three choices clearly;
- Issue #20 may implement all three behaviors and is no longer blocked on the product-owner decision.
