# Outbound Acquisition / Prospecting Handoff — Phase 5 Future Compatibility

## Purpose

The current omnichannel product is the conversation/engagement system that owns supported customer conversations after a person has entered an eligible messaging flow. A future separate acquisition product may discover/import cold prospects, enrich them, personalize permitted outreach and hand engaged prospects into this product.

The two products must integrate cleanly without merging their responsibilities.

Conceptually:

```text
Acquisition / Prospecting Bot
  -> prospect discovery/import
  -> enrichment + contact points
  -> deduplication
  -> channel/legal eligibility
  -> personalization
  -> permitted outbound campaign
  -> click / reply / other verified engagement
  -> HANDOFF

Omnichannel AI Setter
  -> Contact / Conversation / Lead creation or resolution
  -> Inbox
  -> AI dialogue
  -> qualification / booking / human takeover
  -> downstream result attribution
```

## Separation of concepts

A cold database record is a `Prospect`, not automatically a `Lead`.

- `Prospect` — a potential target discovered/imported upstream, possibly with one or more contact points.
- `Engaged Prospect` — the person/company has performed a verified engagement action such as replying or using an allowed CTA/deep-link flow.
- `Contact` — canonical person/customer identity inside one Business Profile once it is valid to create/use that identity in the conversation product.
- `Lead` — created only after a meaningful commercial/goal-oriented signal according to existing Leads policy.

Do not create thousands of cold `Lead` records in the main Inbox/CRM merely because an acquisition crawler found them.

## Prospect record / mini-CRM direction

The future acquisition product should use its own durable prospect store. Google Sheets may be an export/view/edit surface where appropriate, but should not be the only authoritative system of record.

A prospect may contain normalized fields such as:
- upstream `prospect_id`;
- person/company/agency name;
- website/domain;
- source URL / discovery provenance;
- country/city/language;
- segment / campaign fit / score;
- phone numbers;
- WhatsApp-capable number where verified;
- Telegram username / contact point where usable;
- Instagram username/profile reference where usable;
- email addresses;
- other future channel identifiers;
- deduplication keys;
- personalization facts with provenance;
- generated first-line/personalization draft;
- campaign assignment;
- outreach status;
- last outreach attempt/result;
- opt-out / suppression status;
- engagement state;
- handoff state.

Unknown or inferred values must not be silently presented as verified facts.

## Contact-point model

Do not hard-code one flat row as the domain model even if Google Sheets renders it that way.

Conceptually use multiple `ProspectContactPoint` records, for example:

```text
EMAIL          value=...
PHONE          value=...
WHATSAPP       value=...
TELEGRAM       value=...
INSTAGRAM      value=...
```

Each contact point should preserve source/provenance, verification state, last-used state, suppression/opt-out state and channel eligibility metadata.

This lets the acquisition product export columns to Sheets while keeping a normalized internal model.

## Outreach personalization

The acquisition LLM may generate:
- a short personalized opening based on verified prospect/business information;
- a reusable campaign body/value proposition;
- a channel-appropriate CTA such as `Learn more`, `Reply`, `Book demo`, or a deep link.

Personalization must not invent facts about the prospect. The source data used for personalization should remain attributable/auditable.

A campaign template should therefore conceptually separate:

```text
personalized opener
+ campaign value proposition
+ CTA
```

rather than regenerate an uncontrolled full sales script for every contact.

## CTA abstraction

Do not assume every channel supports the same visible button.

Represent the product intent as a normalized CTA, for example:
- `LEARN_MORE`;
- `REPLY`;
- `OPEN_CHAT`;
- `BOOK_DEMO`;
- `VISIT_PAGE`.

Each channel adapter maps that intent to a currently permitted provider mechanism: button, template action, deep link, normal reply instruction, tracked link, or no action when the platform does not support it.

Channel/provider policy remains authoritative; the system must not use unofficial automation to simulate a CTA or cold-send path that the platform does not permit.

## Handoff contract

The acquisition product should hand off through a versioned, idempotent application/API event rather than writing directly into conversation tables.

Suggested normalized event:

```text
PROSPECT_ENGAGED
```

Payload direction:
- `event_id` / idempotency key;
- upstream `prospect_id`;
- `campaign_id`;
- target `workspace_id` / `business_profile_id` mapping;
- engagement channel;
- verified contact point(s);
- original outreach operation/reference;
- original personalized message snapshot;
- engagement type (`REPLY`, `CTA_CLICK`, `OPEN_CHAT`, etc.);
- customer inbound text/event reference when available;
- language/locale hints;
- source/attribution metadata;
- personalization facts/provenance safe to transfer;
- consent/eligibility/suppression metadata relevant to the handoff;
- timestamps.

The omnichannel product must validate the event, scope it to the Business Profile, deduplicate it and never trust an upstream display name alone as identity proof.

## Conversation creation rule

The preferred handoff is a real provider-supported conversation/inbound event.

If the prospect clicks `Learn more` and opens/sends into the business account, normal channel webhook ingestion should remain the canonical conversation path. The acquisition handoff supplies attribution/context and is correlated to that inbound event.

If a future channel/API supports a verified server-side transition without a separate webhook, the adapter may normalize it, but the core product must still enforce channel eligibility and identity safety.

A CTA click by itself does not imply that every provider permits an automated conversational message immediately afterward.

## Identity resolution

On handoff:
- resolve an existing Contact only from reliable identifiers or explicit mapping;
- do not merge identities because names look similar;
- keep Business Profile tenant boundaries;
- preserve upstream prospect ID as external attribution, not as the canonical customer ID.

If the same engaged prospect later arrives from another supported channel, normal ContactIdentity merge rules apply.

## Attribution loop

The integration should be bidirectional at the event level.

The acquisition product sends campaign/source context downstream. The omnichannel system may later emit normalized outcomes upstream, such as:
- conversation started;
- Lead created;
- QUALIFIED;
- BOOKED / NEXT_STEP;
- WON;
- LOST;
- opt-out;
- human takeover / sales follow-up needed.

This allows acquisition analytics to answer which sources/campaigns actually produced qualified conversations and revenue rather than optimizing only for sends/clicks.

## Google Sheets integration direction

Google Sheets is useful for:
- prospect review;
- manual enrichment/correction;
- campaign staging;
- export/reporting;
- operator-friendly bulk visibility.

But outbound execution must not depend on a fragile spreadsheet row as the only transaction record.

The acquisition service should maintain durable IDs/state and synchronize selected fields to Sheets. Row deletion or manual reordering must not silently delete core prospect/audit history.

## Channel / compliance guardrail

Cold outreach eligibility is channel- and jurisdiction-dependent and may change over time.

Before any outbound attempt, the acquisition system must evaluate normalized policy such as:
- whether this channel/provider permits the proposed outreach path;
- required consent/opt-in/legal basis metadata where applicable;
- approved template/CTA requirements;
- suppression/opt-out state;
- rate/quality limits;
- business/account capability;
- local/legal policy configured for the campaign.

A discovered contact point is not automatically permission to message it.

The architecture should fail closed when eligibility is unknown rather than bypass official platform rules.

## Action and send safety

Every outbound campaign send should have:
- stable logical operation ID;
- deterministic channel eligibility check;
- idempotent/reconciliation-safe execution where the provider permits;
- normalized result (`SENT/ACCEPTED`, `REJECTED`, `AMBIGUOUS`, etc.);
- no blind retry after ambiguous side effects;
- audit/provenance;
- suppression handling after opt-out/refusal.

## Integration boundary with current product

The current omnichannel product should expose a future provider-neutral `AcquisitionHandoffPort` / public API boundary rather than depending on the implementation language/database of the prospecting bot.

The handoff should reuse existing product concepts after entry:
- Business Profile;
- Contact / ContactIdentity;
- Conversation;
- Lead;
- Knowledge;
- Style;
- Goals / Follow-ups;
- Booking;
- Review / Human takeover.

The acquisition product owns discovery and cold-campaign state. The omnichannel product owns live customer conversation state after handoff.

## Product strategy

Build the current conversation product so that a future acquisition bot can plug in as an upstream source without redesigning Inbox/Lead/Conversation architecture.

Do not expand the initial omnichannel MVP into a cold-outreach crawler/campaign engine now. Preserve the boundary, event contract and attribution hooks so the future product can be developed independently and integrated cleanly.
