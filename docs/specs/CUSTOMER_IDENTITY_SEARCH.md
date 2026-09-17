# Customer Identity / Deduplication / Search — v0.1

## Product principle
One customer may appear through several channels and external systems, but identity linkage must be evidence-based. Similar names, usernames or semantic resemblance are never sufficient for automatic merge.

Identity scope defaults to one Business Profile. Cross-Business-Profile identity linking is not automatic and sensitive Business Profiles must not reveal possible identity matches elsewhere by default.

## Core entities
- `Contact`: canonical customer/person within one Business Profile.
- `ChannelIdentity`: provider/channel-specific identity such as Instagram sender ID or WhatsApp identity.
- `ContactPoint`: phone/email and similar customer contact coordinates.
- `ExternalIdentity`: stable external-system identity such as HubSpot contact ID or future prospecting-bot prospect ID.
- `ContactLink` / `MergeRecord`: records why identities/contacts were linked, by whom/what evidence, and whether the link was automatic or human-confirmed.

## Evidence classes
### Strong deterministic evidence
May support automatic linking when scope/policy allows:
- same immutable/stable provider identity in the same channel account context;
- same authoritative external identity from the same source system;
- explicit system correlation/handoff where the upstream identity and real provider inbound can be reliably matched;
- human-confirmed identity assertion.

### Strong suggestion, not unconditional auto-merge
- matching verified phone across independent sources;
- matching verified email across independent sources.

Phone/email reuse, shared family numbers and shared business inboxes make these unsafe as universal automatic merge keys.

### Weak evidence only
- same/similar name;
- username/display name;
- company name;
- profile image similarity;
- semantic similarity of messages.

Weak evidence may surface `Possible duplicate` but must never autonomously merge customers.

## Provider identifiers
Provider IDs are preferred over mutable usernames. Usernames/display names are retained as attributes/history, not canonical stable identity keys.

## Merge semantics
Merging does not flatten all source records into an irreversible row. A canonical Contact links identities while preserving separate channel conversations and provenance.

Example:
- one Contact;
- Instagram identity and conversation;
- WhatsApp identity and conversation;
- CRM external ID;
- email/phone contact points.

Cross-channel context may be used by AI only when linkage is sufficiently reliable and Business Profile policy allows it.

## Fact conflicts
Customer facts/preferences preserve source provenance. A merge must not silently overwrite contradictory facts.

If two sources disagree, keep both source claims/status and resolve through freshness/confirmation rules or customer clarification. A direct current customer statement can supersede an older fact without erasing provenance.

## Contact is not Lead
One Contact may have multiple Leads/opportunities over time. Contact merge does not automatically merge or delete lead records.

## Unmerge / split
Human-confirmed merges must be reversible where technically possible. Audit preserves:
- contacts/identities merged;
- evidence/reason;
- actor;
- timestamp;
- subsequent split/unmerge.

A mistaken merge must not force permanent contamination of conversations or reusable customer memory.

## ContactPoint lifecycle
Suggested states:
- `VERIFIED`;
- `UNVERIFIED`;
- `SUPERSEDED`;
- `INVALID`.

Store provenance, first-seen and last-confirmed timestamps. Replaced phone/email values may remain historical but should not be used for new outbound activity once superseded.

Avoid aggressive provider-specific email normalization that could create false matches. Preserve the original value and a conservative normalized form.

## Recycled identifiers
Phone numbers and other identifiers can be reassigned. After a long gap or contradictory strong identity evidence, the system may mark a possible reassignment and must avoid exposing prior sensitive memory until linkage is reconfirmed.

## Search
Authorized search may cover:
- contact name;
- phone/email;
- channel username/display value;
- external/customer/order IDs;
- tags;
- company/lead fields;
- message text;
- relevant notes.

Search is always authorization-scoped before results are produced. A member without access to a Business Profile must not learn that a matching Contact exists there.

`All businesses` results must display the Business Profile context clearly.

## Message search
Start with lexical/full-text search over authorized data. Semantic search may be added later for message meaning, but embeddings/semantic similarity must never be used as identity evidence.

Search indexes are derived data: authoritative database state is the source of truth. Deletion/retention workflows must remove corresponding derived index entries.

## Prospecting-bot linkage
Before engagement, an upstream acquisition record remains a Prospect. After a real engagement/inbound event, the application may link:

`Prospect -> Contact`

when reliable correlation exists. Prospect attribution is retained rather than destroyed so analytics can follow Prospect -> Contact -> Lead -> Qualified -> Booking -> Won/Lost.

If evidence is insufficient, preserve an unmatched/possible-match state instead of guessing.

## CRM imports
The strongest external match is `(source_system, external_contact_id)`. Re-importing that identity updates/relinks the same external identity rather than creating a duplicate.

Matching email/phone from a different independent CRM/source is a duplicate candidate, not unconditional proof.

## Possible-duplicate UX
Possible duplicates should be non-disruptive. A Contact profile may show a card with evidence and actions:
- `Merge contacts`;
- `Keep separate`.

Before merge, show affected identities, conversations, customer facts and leads/opportunities. Merge permission is role/policy controlled and audited.

## Sensitive Business Profiles
Sensitive profiles use stricter identity isolation. Cross-BP duplicate suggestions should be disabled by default so an operator in one business cannot infer that the same person exists in a sensitive business elsewhere in the Workspace.

## Architecture invariant
`raw identifiers -> conservative normalization -> evidence evaluation -> scoped canonical Contact linkage -> provenance preserved`

Forbidden shortcuts:
- auto-merge from name/username/photo similarity;
- LLM-based identity guessing;
- default cross-Business-Profile customer graph;
- irreversible merge without provenance/audit.