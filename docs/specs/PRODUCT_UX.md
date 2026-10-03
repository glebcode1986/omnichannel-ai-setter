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

### Inbox implementation notes (P5-02)

These record what the Inbox actually does where the description above left a choice open. They are
implementation decisions, not changes to the product direction; each one is called out because it is
visible to an operator.

**"Unread" is "awaiting reply".** There are no read receipts in this product and no per-user read markers.
What an operational inbox means by unread is "the customer spoke last and nobody has answered", and that
is already in the data as `lastInboundAt > lastOutboundAt`. Introducing a read marker would be a product
feature with its own multi-operator semantics — whose read counts, and does opening a conversation answer
it — so the filter and the badge are labelled "Awaiting reply" instead of claiming something the data does
not know.

**The view lives in the URL.** Search, filters, the selected conversation and the page position are all
query parameters or route segments. A reload, the back button and a pasted link therefore agree about what
is on screen, and the list works before JavaScript arrives. Unrecognised parameters — a filter nobody
defined, a cursor that no longer parses — fall back to the default view rather than failing.

**Paging is by cursor, and there is no virtualization.** The list reorders itself whenever a customer
writes, so a page number would point at different conversations a minute later; the cursor is
`(lastMessageAt, id)`, which is the index the profile inbox is already served by. A page is bounded (30 by
default, 100 at most) and "load older conversations" is a link to the next cursor. This is the
large-inbox strategy: a fixed amount of DOM and one bounded query per screen, rather than a virtualized
list over an accumulating client-side store. Virtualization would only become relevant if a single page
grew large, which the bound prevents.

**Mode badges show the mode in force.** A conversation's own override is not the effective mode — a
conversation with no override inherits its channel account's policy, then the Business Profile's default,
then `OFF`. The precedence has one implementation (`packages/db/src/automation-mode.ts`) shared with the
draft pipeline, so the mode an operator reads is the mode that decides whether we send.

**The Inbox reads; it does not act.** The context pane shows the latest AI decision, its reason codes and
its cited sources, and says in words that approving and editing arrive with the Review queue. There are no
disabled action controls: a greyed-out Approve button reads as "you may not", which is a different and
false statement from "this is not built yet". The composer and the review actions belong to P5-03.

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
