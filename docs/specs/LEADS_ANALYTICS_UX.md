# Leads + Analytics UX — Phase 5

## Leads

The lead system is conversation-linked CRM-lite, not a separate heavyweight CRM.

A conversation exists for every customer interaction. A `Lead` is created only once there is a real commercial/goal-oriented signal or when a human explicitly creates one; a greeting alone does not have to create a full lead record.

### Default pipeline
Suggested initial stages:
- NEW
- ENGAGED
- QUALIFYING
- QUALIFIED
- BOOKED / NEXT_STEP
- WON
- LOST

Business Profile configuration may rename/reorder/add stages within product limits. Stable internal IDs remain separate from display labels.

Pipeline/qualification policy is scoped to the Business Profile, not only to the whole workspace, because different businesses in one workspace may have different sales processes and qualification criteria.

### Qualification model
`QUALIFIED` is business-defined rather than hard-coded globally.

A Business Profile may define:
- what qualifies a lead;
- required/optional qualification fields;
- custom fields such as budget, city, property size, car model, wedding date, company size, preferred service, etc.;
- whether particular stage transitions may be automated or require human confirmation.

AI should capture qualification information naturally from the conversation and must not ask again for information already supplied in the current/relevant history.

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
- concise conversation/lead summary;
- stage history and source actor (`AI_SUGGESTED`, `AI_SET`, `HUMAN_CONFIRMED`, `HUMAN_SET`).

AI stage suggestions are advisory unless Business Profile policy permits an automatic stage transition. High-impact stages such as WON/LOST must remain auditable and reversible; a business may require human confirmation for them.

When a lead becomes QUALIFIED, the notification system may notify configured owners/managers while AUTOPILOT continues handling the conversation unless review/takeover policy says otherwise.

### Contact identity / merge safety
The same real customer may contact the business through Instagram and WhatsApp. The product may support merging channel identities into one Contact/Lead when there is reliable evidence or an explicit human merge.

Never auto-merge merely because display names are similar. Ambiguous identities remain separate until a stronger identifier or human decision exists. Merges must be reversible/auditable where practical.

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
- member/role changes;
- lead stage/qualification policy changes and contact identity merges.

Audit records are append-oriented and workspace scoped.
