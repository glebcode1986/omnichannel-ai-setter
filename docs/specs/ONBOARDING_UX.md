# Client Onboarding UX — Phase 5

## Goal

Get a new workspace from signup to safe first conversation without requiring technical knowledge.

## Recommended onboarding sequence

### Step 1 — Workspace
Collect business/workspace name, timezone, primary language(s), and optional website/brand context. Create the workspace before connecting channels.

### Step 2 — Connect channels
Offer Instagram and WhatsApp as independent cards with connection status. A customer may launch with one channel and add the other later.

Show only provider-required authorization and current capability state. Do not ask users to paste access tokens into ordinary UI.

### Step 3 — What the AI should do
Configure:
- business goal / setter goal;
- what counts as a qualified lead;
- lead stages;
- preferred default AI mode: OFF / DRAFT / AUTOPILOT;
- confidence/review posture via simple presets first, advanced controls later.

### Step 4 — Knowledge
Allow:
- paste text / FAQs;
- structured business facts;
- upload supported documents later when file ingestion exists;
- website/import connectors as future capability.

Explain explicitly: Knowledge controls facts, not writing style.

### Step 5 — Style
Offer three ways to teach voice:
- concise written style instructions;
- selected real human conversation examples;
- later: import/review suggested examples from connected history where platform/API access permits.

Explain explicitly: Style examples influence phrasing and never become factual authority.

### Step 6 — Timing & handoff
Configure simple presets:
- Fast;
- Natural (recommended product preset using configured debounce/delay bounds);
- Custom.

Also configure human takeover resume policy and business/quiet hours where applicable.

### Step 7 — Channel-specific outside-window behavior
Instagram: select `STANDARD_ONLY` or `HUMAN_ASSISTED_EXTENDED` when the capability is relevant/approved.

WhatsApp: select one of:
- `SERVICE_WINDOW_ONLY`;
- `TEMPLATE_REVIEW`;
- `TEMPLATE_AUTOPILOT`.

`TEMPLATE_AUTOPILOT` requires an explicit template/use-case allowlist before activation.

### Step 8 — Test before go-live
Use a test/sandbox conversation or simulation that shows:
- retrieved knowledge;
- generated answer;
- confidence/reasons;
- mode decision;
- expected delay;
- whether the system would send or hold.

### Step 9 — Activation
Activation checklist must show channel connection, knowledge present, style configured or intentionally skipped, policy selected, and unresolved blocking review items.

Before first AUTOPILOT activation, explain in plain language:
- AUTOPILOT runs on the server and continues when the dashboard/browser/computer is closed;
- human takeover always wins;
- uncertain/unsupported cases may be routed to Review instead of being sent;
- where the connected channel exposes reliable native-app outbound echoes, manually replying from the native business app can pause AI for that conversation;
- provider/capability limitations must be shown honestly when native-app takeover detection is not available.

AUTOPILOT activation requires an explicit owner/admin action; it must never be inferred merely from finishing onboarding or closing the activation screen.

## Progressive disclosure

The first-run experience should use plain-language presets. Advanced controls remain available in Settings but should not block a non-technical owner from launching.

## Safety/UX invariants

- no production secret is displayed after secure storage;
- workspace roles constrain channel connection and policy changes;
- incomplete Meta authorization is shown as an actionable connection problem, not a generic error;
- the UI must distinguish `configured`, `connected`, `eligible`, and `currently sendable` states;
- onboarding can be resumed without losing prior steps;
- browser/WebSocket presence must never be required for AUTOPILOT operation;
- reconnecting the dashboard reconstructs current automation/conversation state from server-authoritative records.
