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

## Interaction invariants

- UI never presents a send as guaranteed before the delivery coordinator reports accepted/provider state.
- Human action visibly overrides automation.
- Account/channel policy state is revalidated server-side; UI eligibility is informative, not authoritative.
- Workspace scoping applies to every query/action.
- Destructive/high-impact actions require explicit confirmation where appropriate.
- Accessible keyboard navigation and responsive behavior are required for inbox/review workflows.

## Mobile

Mobile uses stacked navigation rather than three panes:
1. conversation list;
2. conversation;
3. contact/AI details as drawer/sheet.

Critical actions — reply, take over, approve/edit/reject, mode state — remain reachable without desktop-only hover interactions.
