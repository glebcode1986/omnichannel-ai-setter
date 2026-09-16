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

### Goal-aware analytics
Analytics is anchored to the **Business Profile objective**, not hard-coded only around conventional sales.

Examples:
- sales profile: Conversation -> Engaged -> Qualified -> Next step / Booking -> Won;
- support profile: Incoming -> AI resolved -> Human escalation -> Resolved;
- education profile: Inquiry -> Engaged -> Qualified/eligible -> Enrollment/next step;
- hospitality/concierge: Inquiry -> Relevant request -> Booking/arrangement -> Completed;
- relationship/dating service: New contact -> Meaningful conversation -> Qualified interest -> Human/manager handoff -> Booking/next step.

The product may retain stable internal event/metric semantics while showing profile-appropriate labels and goals.

### Primary dashboard
Prefer a compact operational dashboard rather than dozens of charts. The initial summary should focus on approximately 6–8 high-value indicators such as:
- conversations in the selected period;
- conversations fully handled by AI;
- conversations requiring human takeover;
- Review items created / currently unresolved;
- median and percentile first-response time;
- target events achieved for the Business Profile;
- conversion to the configured target event;
- conversations currently requiring attention.

### AI Quality
Provide a dedicated quality view that helps the owner improve the system rather than merely observe message volume.

Track where available:
- `MISSING_FACT` frequency and top missing topics;
- human edit rate before send;
- common Review reasons;
- human takeover rate and reasons;
- Knowledge gaps/stale-source hits;
- repeated human Style edits;
- AI-held/skipped sends;
- unsupported media/transcription problems;
- delivery/provider failures and ambiguous outcomes.

The product may derive aggregate improvement suggestions from repeated edits, for example:
- humans repeatedly shorten AI responses;
- formal greetings are regularly removed;
- sales pressure is consistently reduced;
- warmth/playfulness is regularly increased/decreased.

Such observations may propose a Style/Knowledge change but must not silently mutate configuration.

### AUTOPILOT health
Expose current operational automation state, including:
- conversations currently AI-controlled;
- `HUMAN_ACTIVE` conversations;
- `REVIEW_REQUIRED` conversations;
- paused/blocked automation;
- channel connection/eligibility problems;
- exhausted voice allocation / transcription unavailable state;
- failed or ambiguous deliveries;
- provider/window/template limitations that currently prevent autonomous sends.

This view is diagnostic/operational and should not depend on browser presence for correctness.

### Additional MVP metrics
- inbound conversations/messages by channel/Business Profile;
- AI drafts generated;
- auto-sent vs reviewed vs skipped/held;
- lead-stage movement and qualification rate where lead pipeline applies;
- target-event movement for non-sales profiles;
- AI/provider usage/cost telemetry when available.

### Filters
Workspace date range, Business Profile, channel/account, AI mode, lead/goal stage, assigned member.

### Retention / packaging
Initial product packaging:
- Starter: 30-day analytics history with core operational metrics;
- Growth: 6-month analytics history plus conversion/channel/team/review/knowledge quality analysis;
- Scale: 24-month analytics history plus cross-Business-Profile rollups, export and deeper audit/operational analysis.

Feature wording remains subject to final launch marketing, but retention/capability differences must be entitlement-driven rather than only hidden in UI.

### Definitions
Metric definitions must be documented and consistent. UI must distinguish provider delivery/read status from application accepted/scheduled state.

Do not present model/provider token usage or message count as a public success KPI when the business objective is booking, qualification, support resolution or another meaningful outcome.

## Audit

Analytics and Audit are separate product concepts:
- **Analytics** answers: how is the business/AI performing?
- **Audit** answers: who changed what, and when?

### Material audited actions
Maintain a searchable append-oriented record for material actions including:
- channel connect/disconnect;
- policy changes;
- OFF/DRAFT/AUTOPILOT mode changes;
- Knowledge version/activation/archive changes;
- Style profile/archetype/dimension changes;
- human takeover/resume;
- reviewed/edited/rejected AI drafts;
- template-autopilot policy/allowlist changes;
- ambiguous-send manual resolution;
- member/role changes;
- lead stage/qualification policy changes and contact identity merges;
- notification policy changes where operationally relevant.

An audit item should preserve actor, timestamp, workspace/Business Profile scope, action type and a safe representation of material before/after values where appropriate.

Example display:
- `14:32 — Anna changed Style: Warmth Medium -> High; Flirtation Light -> Playful`
- `16:08 — Owner enabled AUTOPILOT for Business Profile X`

Audit history must not be silently rewritten by editing the current object. Sensitive values/secrets are never copied into audit payloads.

Audit records are workspace scoped and append-oriented; access/retention/export capabilities may vary by plan.