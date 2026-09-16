# Leads + Analytics UX — Phase 5

## Leads

The lead system is conversation-linked CRM-lite, not a separate heavyweight CRM.

### Default pipeline
Suggested initial stages:
- NEW
- ENGAGED
- QUALIFYING
- QUALIFIED
- BOOKED / NEXT_STEP
- WON
- LOST

Workspace may rename/reorder/add stages within product limits. Stable internal IDs remain separate from display labels.

### Lead record
Show:
- contact;
- connected channel identities;
- current stage;
- qualification fields captured by AI/human;
- owner/assignee;
- last conversation/channel;
- next action/date where used;
- tags/notes;
- stage history and source actor (`AI_SUGGESTED`, `HUMAN_CONFIRMED`, `HUMAN_SET`).

AI stage suggestions are advisory until policy permits an automatic stage transition. High-impact stages such as WON/LOST should remain auditable and reversible.

### Views
- kanban pipeline;
- compact table/filter view;
- conversation-to-lead side panel inside Inbox.

Dragging a card changes stage through the same server-side transition API and audit path as any other stage change.

## Analytics

Analytics should answer operational questions rather than vanity metrics.

### MVP metrics
- inbound conversations/messages by channel/account;
- median/percentile first-response time;
- AI drafts generated;
- auto-sent vs reviewed vs skipped/held;
- human takeover rate;
- review reasons (low confidence, missing fact, policy/window, unsupported media, etc.);
- lead-stage movement and qualification rate;
- delivery/provider failures and ambiguous outcomes;
- knowledge missing-fact frequency;
- AI/provider usage/cost telemetry when available.

### Filters
Workspace date range, channel/account, AI mode, lead stage, assigned member.

### Definitions
Metric definitions must be documented and consistent. UI must distinguish provider delivery/read status from application accepted/scheduled state.

## Audit

Separate searchable audit log for material actions:
- channel connect/disconnect;
- policy changes;
- mode changes;
- knowledge/style version changes;
- human takeover/resume;
- reviewed/edited/rejected AI drafts;
- template-autopilot policy/allowlist changes;
- ambiguous-send manual resolution;
- member/role changes.

Audit records are append-oriented and workspace scoped.
