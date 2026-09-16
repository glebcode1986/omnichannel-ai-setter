# Product Discovery Handoff — accepted decisions through 2026-09-17

**Purpose:** continuity note for the next product-design session. GitHub remains the source of truth. Read the canonical specs referenced below before changing behavior.

## Current product position

The product is an inbox-first, multi-tenant omnichannel AI setter/support SaaS. Instagram and WhatsApp are first-class channels. AUTOPILOT runs server-side and must continue with all browsers/apps closed. Human activity always wins. AI output is advisory; deterministic server-side policy owns send/hold/skip and all consequential external actions.

## Canonical specs already accepted

Read these first:

- `ARCHITECTURE.md` — runtime boundaries and AUTOPILOT invariant.
- `HUMAN_HANDOFF.md` — NONE / REVIEW_REQUIRED / HUMAN_ACTIVE and resume rules.
- `PRODUCT_UX.md` — inbox-first product shell, Settings/Notifications foundation.
- `TEAM_ROLES_UX.md` — OWNER / ADMIN / AGENT and Business Profile access scope.
- `KNOWLEDGE_STYLE_UX.md` — trusted Knowledge and configurable communication Style/persona.
- `LEADS_ANALYTICS_UX.md` — leads/goals/analytics/audit direction.
- `LOCALIZATION.md` — EN/RU production UI and multilingual customer conversation behavior.
- `PRICING_PACKAGING.md` and `BILLING_ENTITLEMENTS.md` — plans, Business Profile commercial unit, trial, lifecycle and entitlements.
- `GOALS_FOLLOWUPS.md` — goals, next actions, human tasks and conservative follow-ups.
- `BOOKING_APPOINTMENTS.md` — provider-neutral availability/booking, revalidation and reconciliation.
- `OUTBOUND_ACQUISITION_HANDOFF.md` — future prospecting/outbound product and clean handoff into this system.

## Accepted Business Profile direction

A `Workspace` may contain multiple independent `Business Profiles`. A Business Profile represents one business/brand/operating direction and owns or overrides its own objective, Style, Knowledge, pipeline/qualification fields, notifications, team scope, AI mode/policy and connected channels.

Commercially, one Business Profile may contain up to one Instagram account plus one WhatsApp Business account/number. A second Instagram or second WhatsApp connection consumes another Business Profile slot. Underlying channel accounts remain technically separate entities.

Business Profiles must isolate customers by default. Similar names, usernames or contact details across unrelated Business Profiles must not silently merge identities. Cross-profile identity sharing is future explicit functionality only.

Profile lifecycle direction: `SETUP`, `ACTIVE`, `INACTIVE`. Inactive/over-capacity profiles retain history/configuration and are not deleted. Deletion is a separate explicit destructive workflow.

Workspace-wide Knowledge/Style may provide defaults/base material; Business Profile-specific content may override or extend them. Credentials, customer data, conversation history and audit history are never copied by a "duplicate profile settings" action.

## Accepted Review Queue / Human Attention direction

Review blocks only the affected conversation/action, never the entire Business Profile. Typical reasons include missing trusted fact, low confidence, complaint/refund/dispute, unusual discount or condition, explicit request for human, channel-window/provider limitation, media/transcription failure, ambiguous delivery/write outcome, and configured Style/relationship boundary.

Each active Review item should show: customer/conversation, concise context summary, proposed draft/action, why it was held, relevant trusted sources/policy state, and age/wait time.

Primary actions: `Send`, `Edit & Send`, `Dismiss`, `Take over`, `Resume AI`; where relevant, `Add to Knowledge` is available only through explicit human confirmation.

`Dismiss` does not imply HUMAN_ACTIVE. `Take over` does. Assignment does not imply takeover.

Use simple priority classes such as HIGH / NORMAL / LOW. HIGH includes human requested, serious complaint/payment dispute, ambiguous external outcome and other situations needing timely attention.

Stale-draft protection is mandatory: if newer customer/human activity arrives after the review anchor, old drafts cannot be sent without re-evaluation/regeneration. Deduplicate repeated Review causes into one active logical item where practical.

Review creation and notifications are separate: routine Review may exist quietly; notification policy decides whether a human is alerted.

## Accepted Inbox direction

Inbox is the default daily work surface. Desktop uses three panes: conversation list, active thread, customer/lead/AI context. Mobile uses list -> chat -> info drawer.

Conversation-list operational states should remain simple: `AI handling`, `Review`, `Human active`, `Waiting for customer`, `Closed`; unread is a separate property. Secondary lead-stage markers may appear without overwhelming the row.

Quick filters direction: `All`, `Needs attention`, `Mine`, `Unread`, `AI handling`, with advanced filters for Business Profile, channel, stage, assignee, Review reason and operational status.

`Needs attention` is the main work queue combining actionable Review/human-requested/high-priority technical items.

Thread messages distinguish customer, AI, human member and system events. Internal confidence/reason/provenance are never customer-visible.

Top-of-thread controls expose channel, Business Profile, operational state, lead/goal state, assignment and `Take over` / `Resume AI`.

Human intent lock direction: when an authorized human begins composing, temporarily block AI send for a short period; a real human send transitions to HUMAN_ACTIVE. Abandoned typing lock expires automatically (initial direction ~2 minutes). This prevents simultaneous human+AI replies.

Pending delayed AUTOPILOT responses should be visible internally with cancel/takeover control, e.g. `AI reply scheduled in 42 sec`.

Right panel remains compact: Customer, Lead/Goal, AI context, Knowledge used, Notes, and concise AI summary. AI summary is convenience, never factual authority over raw messages/verified facts.

Closing a conversation is not the same thing as marking a lead Lost/Won.

## Accepted Customer / Contact memory direction

The system should be useful across long-running relationships without creating an indiscriminate psychological dossier.

Separate at least:

1. verified/traceable Contact facts;
2. customer preferences relevant to service;
3. bounded conversation summary;
4. ephemeral context that should not become durable personality memory.

Durable facts should carry provenance/freshness metadata conceptually such as source, created_at, last_confirmed_at, valid_until and status (`ACTIVE`, `SUPERSEDED`, `EXPIRED`). New explicit customer information supersedes old conflicting facts.

AI output itself must never become the source of a customer fact. Durable memory may originate from the customer's own message, confirmed human input, or trusted imported system data.

Low-risk obvious memory candidates may be auto-extracted if policy allows; sensitive/ambiguous inferences should require human confirmation or remain ephemeral. Do not convert inferred traits such as wealth, vulnerability, loneliness, manipulability or psychological labels into durable memory.

Relationship-sensitive/private conversation content should not automatically become reusable long-term memory. The product should support correction/forget/retention workflows.

Cross-channel identity linking inside one Business Profile may share memory only after reliable linkage/manual merge. Do not merge on weak evidence such as similar names. Memory does not cross unrelated Business Profiles by default.

Generation priority direction: current customer message -> fresh verified Contact facts/preferences -> relevant bounded history/summary -> Business Knowledge -> Style.

## Accepted integration architecture direction

External systems connect through provider-neutral application ports/adapters. Product logic must not depend directly on Google/HubSpot/provider SDK types.

Integration classes include Calendar/Booking, CRM, Payments, export/automation, Knowledge sources, and later public API/webhooks. Connectors advertise capabilities; UI/product promises only supported capabilities.

Do not implement uncontrolled two-way sync. For each data domain define the source of truth explicitly. Examples: conversation state is ours; calendar availability is the calendar/provider; confirmed payment is the payment provider/server-normalized state.

Use an Action Gateway between AI suggestions and side effects. Model may propose structured actions such as `CREATE_BOOKING`, `CREATE_CRM_LEAD`, `SEND_PAYMENT_LINK`; application policy checks permission, Business Profile scope, current state, entitlement, Review requirement and idempotency before execution.

External actions conceptually classify as `READ`, `REVERSIBLE_WRITE`, and `HIGH_IMPACT_WRITE`; high-impact actions may require explicit Review/human confirmation.

All consequential writes should use idempotency/correlation where possible. Ambiguous outcomes enter reconciliation/manual review instead of blind retry.

A failed connector should pause only dependent capability, not the whole Business Profile. Example: AI may continue answering normal questions while calendar booking is held for attention.

Settings -> Integrations should expose status, Business Profile scope, granted capability/permissions, Configure, Test connection, Reconnect, Disconnect. Request minimum required external permissions. Secrets never enter prompts or audit logs.

Future outbound webhooks/public API should make the platform compatible with Make/Zapier/n8n/custom systems without requiring a native connector for every service.

## Future outbound acquisition / prospecting product

The future prospecting product is an upstream system, not a reason to turn the current inbox product into an unsolicited cold-outreach engine.

It may own prospect discovery/import, enrichment, normalization/deduplication, contact points, campaign personalization, policy-compliant outbound delivery, CTA/engagement tracking and suppression/opt-out.

Keep `Prospect` separate from `Contact`/`Lead`. A cold record does not become a Lead merely by existing. The handoff into the current product occurs on a real engagement event / official inbound path, conceptually `PROSPECT_ENGAGED`.

Google Sheets may be a useful operator view/export but not the sole authoritative database. Model contact points separately (phone, WhatsApp, Telegram, Instagram, email) with verification/status metadata.

Campaign CTA is channel-neutral conceptually (`LEARN_MORE`, `OPEN_CHAT`, `BOOK_DEMO`, `REPLY`); provider adapter renders a button/deep-link/template/text form only when officially supported.

The future prospecting product should communicate with the current product through a versioned API/handoff contract, not direct DB writes. Current product should return normalized downstream outcomes such as Lead created, Qualified, Booked, Won, Lost and Opted out so campaign effectiveness can be measured end-to-end.

## Product-review infrastructure note

Independent Astra review of implementation PRs remains conceptually reviewer-only: exact HEAD SHA, read canonical docs/task contract, run independent verification/adversarial tests, then publish one machine-readable result. If ChatGPT-side Astra credits are unavailable, a future API-based reviewer may implement the same protocol with the API key stored as a secret; never place API keys in repo/chat.

## Next product-design block

Continue with **Voice, Images, Files & Media**.

Key questions for the next session:

- inbound voice transcription and quota behavior;
- image/attachment understanding and unsupported-media Review path;
- file/document handling and malware/privacy boundaries;
- outbound media generation/sending policy;
- how media facts interact with Knowledge and Contact memory;
- retention/storage and plan implications;
- channel-specific media capabilities;
- behavior when transcription/vision provider is unavailable or allowance is exhausted.

After Media, continue product discovery into remaining gaps, then consolidate stale specs/issues before implementation sequencing.
