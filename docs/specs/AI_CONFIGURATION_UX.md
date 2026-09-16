# AI Configuration UX — Phase 5

## Goal

Expose powerful automation controls without making the owner think in model/provider internals.

## Main AI settings

### Behavior
- AI mode default: OFF / DRAFT / AUTOPILOT;
- business/setter goal;
- qualification criteria;
- escalation/review topics;
- concise response guidance;
- language behavior.

### Confidence & review
Start with presets:
- Conservative;
- Balanced;
- Aggressive.

Each preset maps to server-side policy thresholds/review categories. Advanced users may tune exact values later.

The UI must explain outcomes in operational language: `send automatically`, `hold for review`, `do not answer`, never imply that raw model confidence alone controls sending.

### Timing
- Fast;
- Natural;
- Custom.

Display debounce and post-draft delay as ranges/presets. Never promise an exact human-like time for every message.

### Human takeover
- pause automatically on verified manual reply;
- resume manually or after configured policy duration;
- show current takeover owner/state prominently.

### Channel policy
Instagram:
- `STANDARD_ONLY`;
- `HUMAN_ASSISTED_EXTENDED` when capability/approval is available.

WhatsApp:
- `SERVICE_WINDOW_ONLY`;
- `TEMPLATE_REVIEW`;
- `TEMPLATE_AUTOPILOT` with explicit allowlist configuration.

## Provider configuration

Model/provider selection belongs under an Advanced/Infrastructure area, not the primary owner workflow. The product should support a workspace-level default model profile and future plan-level restrictions without exposing SDK-specific details throughout the UI.

## Test playground

Provide a simulation surface using saved workspace configuration. User enters a hypothetical customer message and sees:
- retrieved factual sources;
- style examples selected;
- generated reply;
- confidence/reason codes;
- lead-stage suggestion;
- deterministic policy outcome;
- expected send/review path.

Simulation cannot send a real customer message.

## Change management

High-impact policy changes should show a concise effect summary before save, e.g. switching DRAFT -> AUTOPILOT or enabling `TEMPLATE_AUTOPILOT`.

Audit actor/time and old/new values for material policy changes.
