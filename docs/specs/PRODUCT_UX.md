# Product UX Architecture — Phase 5

**Status:** Prepared for implementation after required backend capabilities exist.

## Product principle

The product is an operational inbox first, not an analytics dashboard first. A connected workspace should spend most of its time in `Inbox`, with review, lead state and AI control available in context.

## Primary navigation

1. **Inbox** — unified Instagram + WhatsApp conversations.
2. **Review** — AI drafts/actions that require human attention.
3. **Leads** — pipeline/lead-stage view across conversations.
4. **Knowledge** — factual business knowledge sources.
5. **Style** — examples/instructions that teach phrasing and tone.
6. **Analytics** — response/review/lead/automation metrics.
7. **Settings** — workspace, channels, AI policy, members, security/audit.

## Inbox layout

Desktop default is a three-pane workspace:

```text
left                 center                         right
conversation list -> active conversation thread -> contact / lead / AI context
```

### Left pane
- search;
- filters by channel/account, unread, review needed, lead stage, human-active, assigned user;
- compact badges for Instagram/WhatsApp, unread, AI mode, review and lead stage;
- latest message preview/time;
- no duplicated channel-specific inboxes for normal daily use.

### Center pane
- chronological message thread;
- clear visual source distinction: customer, AI, human, system/status;
- reply composer;
- OFF/DRAFT/AUTOPILOT effective mode indicator;
- pause/resume human takeover controls;
- pending delayed-send state with cancel option;
- review draft card when applicable;
- provider/window/template warnings shown as operational state, not hidden settings.

### Right pane
- contact identity/channel identities;
- lead stage + qualification fields;
- tags/notes;
- latest AI decision and reason codes;
- factual source provenance used for the latest draft;
- takeover ownership/state;
- account/channel eligibility summary;
- compact activity/audit trail.

## Review queue

Review is a first-class queue. Entries may come from:
- DRAFT mode;
- low confidence;
- missing factual support;
- sensitive/unsupported intent;
- human-assisted Instagram extended-window path;
- WhatsApp `TEMPLATE_REVIEW`;
- media/transcription failure;
- ambiguous send reconciliation/manual resolution.

Each review item shows:
- conversation/customer/channel;
- generated draft/action;
- why review is required;
- supporting facts/source links;
- policy/window state;
- approve, edit+send, reject/dismiss, take over conversation.

Bulk approval is not permitted for customer-facing AI sends in the initial product.

## Settings architecture

Settings should be grouped into understandable sections rather than one long page:
- Workspace;
- Business Profiles;
- Channels;
- AI & Automation;
- Knowledge;
- Style;
- Leads / Goals;
- Notifications;
- Team & Roles;
- Billing;
- Audit / Security.

Most operational behavior that differs between businesses should be Business-Profile-aware rather than globally forced across the workspace.

## Notifications

### Principle
AUTOPILOT should be quiet while everything is working normally. Do not notify an owner for every AI message.

Default high-signal notification classes may include:
- human action required / Review blocker;
- qualified or configured high-value lead;
- customer explicitly asks for a manager, call or human;
- complaint / negative escalation;
- booking / next-step goal reached where configured;
- channel/authentication issue that blocks automation;
- billing/entitlement/voice allowance issue that materially affects operation;
- ambiguous or failed delivery requiring intervention.

### Delivery channels
Initial notification delivery may include:
- in-app;
- email;
- browser/mobile push when supported.

Do not reuse the same customer-facing WhatsApp/Instagram channel as an admin alert transport by default. Dedicated notification connectors may be added later.

### Importance levels
Use at least:
- `CRITICAL` — automation/channel/access cannot safely continue;
- `ACTION_NEEDED` — Review, human requested, qualified/high-value lead, booking/call request;
- `INFORMATIONAL` — summaries and non-blocking status.

### Quiet hours and digests
Workspace/member notification preferences may define quiet hours. Quiet hours suppress or defer non-critical owner notifications but do **not** stop AUTOPILOT itself.

Support digest-style summaries so a user can receive one useful summary instead of many low-value alerts. Example summary fields may include conversations handled, pending Review items, qualified leads and channel warnings.

### Deduplication and escalation
The same unresolved event must not repeatedly generate identical alerts.

Notification state should support deduplication/acknowledgement and optional escalation policies. Example: notify assigned manager first; if an actionable Review item remains untouched for a configured interval, escalate to OWNER/ADMIN.

A quoted or repeated representation of the same underlying event must not create a second logical alert.

### Member and Business Profile scope
Notifications respect member access and assignment. A member who is scoped only to one Business Profile should not receive content/alerts for another profile.

Sensitive profiles should use privacy-preserving push/email previews. For example, a relationship-oriented business may notify `Conversation requires attention` without putting intimate customer text in the lock-screen notification.

### Testing
Provide `Send test notification` / equivalent verification for supported channels so a user can confirm that alerts are actually deliverable.

## Interaction invariants

- UI never presents a send as guaranteed before the delivery coordinator reports accepted/provider state.
- Human action visibly overrides automation.
- Account/channel policy state is revalidated server-side; UI eligibility is informative, not authoritative.
- Workspace scoping applies to every query/action.
- Destructive/high-impact actions require explicit confirmation where appropriate.
- Accessible keyboard navigation and responsive behavior are required for inbox/review workflows.
- Notification preferences never become the authorization boundary for the underlying action.

## Mobile

Mobile uses stacked navigation rather than three panes:
1. conversation list;
2. conversation;
3. contact/AI details as drawer/sheet.

Critical actions — reply, take over, approve/edit/reject, mode state — remain reachable without desktop-only hover interactions.

## Product-owner clarification: OFF mode

`OFF` disables **background/automatic AI generation and all automatic delivery**. It does not prohibit an authorized human from deliberately invoking an explicit `Generate draft / Ask AI` action for the current conversation.

A human-requested draft while effective mode is `OFF`:
- is created only from an explicit authorized user action;
- is never auto-scheduled or auto-sent;
- remains a human-assist artifact that the user must review/edit/send manually;
- is audited as human-requested AI assistance;
- does not enable follow-ups, background generation or AUTOPILOT for later inbound messages.

This keeps `OFF` predictable for automation while preserving useful on-demand assistance.
