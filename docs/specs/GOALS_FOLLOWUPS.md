# Goals, Next Actions & Follow-ups — Phase 5

## Product principle

The product should help a business move a conversation toward an appropriate next step without turning AUTOPILOT into a spam engine.

A Business Profile defines its business goals. AI may suggest and, where explicitly permitted, execute next actions that are consistent with those goals, current conversation state, channel policy, customer consent/preferences and human-takeover state.

Goals, lead stages and follow-ups are related but separate concepts.

- **Goal** — desired business outcome, such as booking, qualification, purchase, handoff, support resolution or continued relationship-oriented engagement.
- **Next action** — the currently recommended operational step for a conversation/lead.
- **Follow-up** — a future outbound attempt or reminder after waiting for a customer or human action.
- **Task/reminder** — a human-facing action that does not itself send a customer message.

## Business Profile goals

Each Business Profile may configure one or more goal types, for example:
- qualify a lead;
- book an appointment/call/demo/date;
- complete an order or purchase step;
- collect required information;
- hand off to a human specialist;
- resolve a support request;
- retain/reactivate a customer;
- continue a relationship-oriented conversation until a configured handoff/booking threshold.

The product must not assume that every profile's goal is a sale.

Goals should support a primary goal plus optional secondary goals. Goal configuration must not override factual, channel, entitlement, handoff or safety policy.

## Next action model

A conversation/lead may have at most one primary active `next_action` plus optional secondary human tasks.

Example next actions:
- `WAIT_FOR_CUSTOMER`;
- `ASK_QUALIFICATION_QUESTION`;
- `OFFER_BOOKING`;
- `SEND_REQUESTED_INFO`;
- `FOLLOW_UP_LATER`;
- `HANDOFF_TO_HUMAN`;
- `HUMAN_CALL_CUSTOMER`;
- `NO_FURTHER_ACTION`.

The AI may suggest a next action as structured output. Deterministic application policy decides whether that action may be scheduled/executed automatically.

## Follow-up policy

Follow-up behavior is Business-Profile-configurable and must be conservative by default.

Initial controls should include:
- follow-ups enabled/disabled;
- maximum automatic follow-up attempts per conversation/goal;
- minimum interval between automatic attempts;
- allowed local hours/dayparts;
- optional quiet days / business hours;
- whether a follow-up requires DRAFT/Review or may run in AUTOPILOT;
- stop conditions;
- channel-specific eligibility behavior.

A reasonable default product preset should use a small number of attempts rather than open-ended persistence. Owners may choose stricter policies; the product should not encourage unlimited chasing.

## Stop / cancellation conditions

Any pending automatic follow-up must be cancelled or re-evaluated when relevant state changes, including:
- the customer replies;
- a human sends/takes over the conversation;
- the customer declines, says stop, asks not to be contacted, or otherwise opts out;
- the goal is achieved or becomes irrelevant;
- lead/conversation state changes to a terminal/incompatible state;
- the underlying draft/context becomes stale;
- channel/account eligibility changes;
- the Business Profile is disabled or automation mode no longer permits the action;
- entitlement/access changes;
- a Review blocker is created;
- a more recent scheduled action supersedes the old one.

Customer opt-out or clear refusal is a hard stop for automated follow-up for the relevant purpose unless a later customer-initiated message clearly reopens the conversation.

## Staleness and final revalidation

A scheduled follow-up is never treated as permission to send later without rechecking current state.

Immediately before generating/sending, revalidate at least:
- latest customer/human message anchor;
- effective OFF/DRAFT/AUTOPILOT mode;
- takeover/Review state;
- current goal/lead status;
- customer opt-out/contact preferences;
- channel policy/window/template eligibility;
- account connection/capabilities;
- entitlement state;
- duplication/supersession state.

If any required invariant changed, cancel, regenerate, hold for Review or create a human task instead of blindly sending the old message.

## Channel policy

Follow-ups must obey the same provider/window rules as any other outbound message.

- Instagram follow-up may only use currently eligible official messaging paths. Extended-window Human Agent behavior remains a deliberate human action where applicable.
- WhatsApp follow-up inside the service window may use the normal service path. Outside it, only approved template behavior configured by policy may be used (`TEMPLATE_REVIEW` or explicitly allowlisted `TEMPLATE_AUTOPILOT`).
- Never use unofficial browser/native-app automation to bypass a platform window or provider policy.

Channel eligibility is re-evaluated at execution time, not assumed from the state when the follow-up was scheduled.

## Tone and context

A follow-up uses the Business Profile's Style and current customer context, but should recognize that a follow-up is not the same as an immediate reply.

It should avoid pretending the customer just wrote, avoid repeated pressure, and vary naturally rather than sending the same canned text repeatedly.

Relationship-oriented profiles may use configured warmth/playfulness in follow-ups, but the same intimacy ceiling and adult-only safeguards apply. Silence is not consent to escalate the tone.

## Human tasks versus customer sends

The system should prefer a human-facing task when the appropriate next action is something a human must do, for example:
- call this customer tomorrow;
- confirm availability with a doctor/agent;
- prepare a custom quote;
- review a sensitive conversation;
- send a personal follow-up.

A human task may have due date/time, assignee, Business Profile, linked conversation/lead and completion status. Completing/dismissing a human task does not itself send a customer message.

## Inbox / Lead UX

The right-side conversation/lead panel should expose:
- current goal;
- next action;
- follow-up status and scheduled time where applicable;
- number of automatic attempts already made;
- assignee for human tasks;
- `Cancel follow-up`, `Reschedule`, `Convert to human task` and appropriate Review/Take over controls.

Inbox filters may include:
- Follow-up due;
- Overdue human tasks;
- Waiting for customer;
- Booking/next-step due.

Do not confuse `Waiting for customer` with unread or human takeover state.

## Notifications

Creating a routine automatic follow-up should not generate a push by itself.

Notify humans when intervention is actually useful, for example:
- a high-value next step needs human confirmation;
- a human task becomes overdue;
- customer explicitly requests a call/person;
- a scheduled action cannot execute due to policy/technical state;
- a booking/goal event configured as important is achieved.

## Analytics

Useful metrics may include:
- follow-ups scheduled/sent/held/cancelled;
- response rate after follow-up;
- goal completion after follow-up;
- opt-out/refusal rate;
- average attempts before response/goal;
- human-task completion/overdue rate.

Do not reward the system for sending more follow-ups. Optimize for goal completion and customer-respectful behavior rather than raw outbound volume.

## Audit

Audit material events including:
- goal-policy changes;
- automatic follow-up policy changes;
- follow-up schedule/cancel/reschedule;
- actor/source of next-action changes;
- opt-out suppression;
- human task assignment/completion;
- any automatic execution that changes a lead/goal state.
