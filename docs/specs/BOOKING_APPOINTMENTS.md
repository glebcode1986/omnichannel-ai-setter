# Booking, Calendar & Appointments — Phase 5

## Principle

Booking is a goal-execution capability, not a special-case chatbot feature. The AI may propose, reserve, create, modify or cancel an appointment only through explicit server-side policy and provider capability.

A model suggestion such as `BOOK_SLOT` is advisory. The application layer revalidates availability, permissions, current conversation state, channel policy and entitlement before any external side effect.

## Business Profile scope

Booking configuration is scoped to a Business Profile because different businesses may have different:
- appointment types;
- calendars/resources;
- staff members;
- locations/timezones;
- duration/buffer rules;
- cancellation/reschedule policy;
- deposit/payment requirements;
- confirmation/reminder behavior.

Workspace-wide defaults may be reused, but availability and booking truth must never be mixed across unrelated Business Profiles.

## Initial booking modes

Support three product modes:

1. `SUGGEST_ONLY` — AI may discuss availability/preferences and suggest next steps, but cannot create an appointment.
2. `REVIEW_BEFORE_BOOK` — AI prepares a proposed appointment/action and an authorized human confirms it.
3. `AUTONOMOUS_BOOKING` — AI may create/modify/cancel appointments automatically when the Business Profile policy explicitly permits it and all deterministic checks pass.

The default for a newly connected calendar should be conservative: `SUGGEST_ONLY` or `REVIEW_BEFORE_BOOK`, not silent autonomous write access.

## Appointment types

A Business Profile may define service/appointment types such as:
- consultation;
- demo;
- dental appointment;
- property viewing;
- discovery call;
- restaurant/date concierge booking request;
- support callback;
- custom business-specific event.

Each type may define:
- duration;
- buffer before/after;
- eligible staff/resources;
- eligible locations or meeting modes;
- operating hours;
- minimum notice;
- maximum booking horizon;
- cancellation/reschedule cutoffs;
- whether human confirmation is required;
- optional deposit/payment requirement metadata.

## Availability

Availability shown to the customer must come from authoritative schedule/calendar/resource data, not from LLM inference.

Before presenting or committing a slot, the system should evaluate at least:
- appointment type;
- Business Profile timezone;
- customer timezone when known/relevant;
- staff/resource eligibility;
- existing busy events;
- working hours;
- buffers;
- minimum notice;
- booking horizon;
- any provider-specific constraints.

Do not invent availability when the calendar connector is unavailable. If availability cannot be verified, the AI should say it needs to check / route to Review rather than fabricate a time.

## Slot presentation

Prefer a small number of useful options rather than dumping an entire calendar.

Example behavior:
- customer: `Can I come Friday evening?`
- system resolves timezone and appointment type;
- AI presents 2–3 currently valid choices such as `17:30`, `18:30`, `19:15`.

If the customer's timezone differs from the business timezone, the product should make the timezone explicit when ambiguity matters.

## Hold vs confirmed booking

Do not treat a displayed slot as reserved unless the connected provider supports and the product explicitly creates a hold.

Conceptually distinguish:
- `AVAILABLE` — observed available at lookup time;
- `HELD` — temporarily reserved where supported;
- `CONFIRMED` — provider/system confirms durable booking;
- `CANCELED`;
- `RESCHEDULED`;
- `FAILED` / `RECONCILIATION_REQUIRED`.

Availability may change between lookup and booking. Final booking always rechecks / handles provider conflict.

## Appointment write safety

External calendar writes require idempotent operation/correlation identifiers where possible.

A timeout or ambiguous provider response must not be blindly retried if doing so could create duplicate appointments. Ambiguous outcomes enter reconciliation/manual review until the system can determine whether the appointment exists.

A customer-facing confirmation must not be sent as if the appointment is confirmed until the booking provider/application state confirms success.

## Required customer information

The AI should collect only fields needed for the selected appointment type and should not ask again for facts already known in current trustworthy Contact memory/conversation context.

Examples may include:
- name;
- phone/email when needed by the provider/business;
- service requested;
- preferred date/time;
- location/mode;
- staff preference;
- short operational note.

Do not turn appointment intake into a rigid questionnaire when the information can be gathered naturally.

## Confirmation flow

On successful booking, the conversation may show a structured appointment card with:
- service/type;
- confirmed date/time + timezone;
- staff/resource when relevant;
- location or online-meeting details;
- confirmation/provider reference where safe to expose;
- reschedule/cancel controls according to policy.

The lead/goal system may move to `BOOKED / NEXT_STEP` only after the booking is actually confirmed, not merely proposed.

## Reschedule and cancellation

Reschedule is modeled as an explicit operation, not an invisible text edit.

Before rescheduling/canceling, re-check:
- appointment still exists;
- actor/customer is authorized for that appointment;
- current provider state;
- cancellation/reschedule cutoff;
- any payment/deposit consequences;
- human-review requirement.

Keep auditable references between the old and replacement appointment where practical.

## Deposits and payments

Initial architecture should allow appointment types to require a deposit/payment, but booking must not infer payment success from a browser redirect or customer statement.

If payment is required before confirmation, the appointment remains pending/held according to provider capability until authoritative payment confirmation arrives.

Billing for the SaaS subscription and customer appointment payments are separate domains even if they later share a payment provider adapter.

## Reminders

Appointment reminders are follow-up automation and inherit the same deterministic send rules as other follow-ups.

Configurable examples:
- confirmation immediately;
- reminder 24h before;
- reminder 2h before.

Every reminder is revalidated before send. Cancelled/rescheduled appointments must invalidate stale reminders. Channel windows/template rules still apply.

## Calendar connectors

Design calendar integration behind a provider-neutral application port. Candidate/future adapters may include Google Calendar, Microsoft/Outlook, Calendly-like scheduling systems, CRM/vertical booking APIs or custom business calendars.

Provider SDK types and credentials remain infrastructure concerns. Product/domain logic works with normalized concepts such as availability, resource, booking, cancellation and provider reference.

## Inbox UX

The active conversation may show a compact booking block:

- `Goal: Book consultation`
- `Status: Proposed / Awaiting confirmation / Confirmed`
- selected appointment type;
- proposed or confirmed time;
- assignee/resource;
- actions such as `Book`, `Change time`, `Cancel`, `Open calendar`, depending on permissions and mode.

Do not hide an appointment only in the external calendar; the customer conversation and lead context should reflect the operational state.

## Human takeover and Review

Booking-related Review reasons may include:
- no trustworthy availability source;
- requested exception outside working hours;
- requested discount/custom condition;
- resource conflict;
- deposit/payment uncertainty;
- cancellation policy exception;
- ambiguous provider write result;
- connector failure;
- appointment type configured as human-confirm-only.

A booking Review item blocks only the affected conversation/action, not all AUTOPILOT activity for the Business Profile.

## Analytics

Useful booking analytics include:
- proposed -> confirmed conversion;
- confirmed -> completed / canceled / no-show when data exists;
- time from first conversation to booking;
- booking source by channel/Business Profile;
- reschedule/cancellation rate;
- AI-autonomous vs human-confirmed bookings;
- booking failures/conflicts/reconciliation cases.

Avoid treating a proposed slot as a conversion.

## Audit

Audit material actions:
- calendar connection/disconnection;
- booking mode/policy change;
- appointment type/resource configuration;
- appointment create/reschedule/cancel;
- actor/source (`AI`, human member, external provider event);
- provider reference/correlation metadata without secrets;
- ambiguous/reconciled outcomes;
- payment/deposit state transitions when relevant.

## Safety / privacy

Only expose calendar information needed for the current booking. Do not reveal unrelated event titles, attendee names, private notes or other customers' schedule details to the AI/customer.

Free/busy or normalized availability should be preferred over broad raw calendar visibility whenever possible.
