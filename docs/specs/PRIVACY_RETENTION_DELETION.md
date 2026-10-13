# Privacy, retention and deletion — v0.1 (P3-04)

Issue #57 names an "accepted Security / Privacy / Data Retention / Deletion product contract in
repository/handoff". No such document existed, so this is it, written from what the code now does. Where
something is deliberately not implemented it says so, with the reason.

## What counts as whose data

- **Customer personal data** — a customer's words, their names, their phone numbers and e-mail addresses,
  the media they send and the machine's reading of it, and anything inferred about them.
- **Derived AI data** — transcripts, conversation summaries, customer facts and preferences, style
  examples learned from them, and the embeddings of any of it. Derived data is customer data. A product
  that deleted the correspondence and kept the summary has not forgotten anybody.
- **Operational data** — jobs, outbox entries, idempotency ledgers, audit events. These carry identifiers
  and outcomes, never message bodies.
- **Secrets** — provider credentials. Encrypted at rest, never logged, never exported, never in a prompt.

## Least privilege

Authorization is Workspace + role + Business Profile scope + action. Scope alone is not permission:
reading a thread is an agent's job, while taking the whole of somebody's history out in one action, or
destroying it, are separate capabilities.

Admin or owner only:

- exporting a customer's data (`exportContact`);
- requesting or carrying out a deletion (`requestDeletion`, `requestProfileDeletion`);
- forgetting a customer's memory (`forgetCustomer`);
- writing a Workspace-scoped knowledge source or style example — these are read by *every* Business
  Profile, so creating one from a single profile's screen is a cross-profile write.

A removed member loses access on their next request, because every request re-reads the membership row
and nothing is cached in the session. What they did stays attributed to them: history is attribution, not
access.

## Deletion

Four scopes, chosen when the request is made and never widened:

| Scope | Removes | Keeps |
| --- | --- | --- |
| `CONTACT` | the person, their conversations, and everything derived from them | an opt-out, as a tombstone (below) |
| `CONVERSATION` | one thread and what was derived *from that thread* | the contact, and what was learned in their other threads |
| `BUSINESS_PROFILE` | every customer in it | the profile itself; deactivation is the other thing |
| `WORKSPACE` | every profile's customers | records a regulator or payment provider requires |

The workflow is durable: `REQUESTED → PROCESSING → COMPLETED | PARTIAL_FAILURE`. `PARTIAL_FAILURE` is
terminal rather than a retry — a deletion that removed some things and not others must not read as done,
and must not quietly try again on a different schedule.

**The provider's copy goes first.** A media id is the only handle on a recording held at Meta, so the
provider delete runs before the row that names it. A deployment that cannot reach the provider records
`NO_MEDIA_PORT` and the request is a partial failure — a `COMPLETED` deletion that left a voice note on
somebody else's servers would be a lie.

**An opt-out is a tombstone, not a deletion.** You cannot both forget somebody and remember never to
message them. A contact with a standing suppression keeps the contact row and the provider's own id for
them, loses their names, numbers, correspondence and derived data, and keeps the opt-out. That is the
minimum that honours the request they actually made.

### What this version does not do

- **Workspace deletion of billing or legal records.** Nothing in this product writes any yet; Phase 6
  defines them, and the retention rule belongs with whatever writes them.
- **Rebuilding search indexes.** Not needed: both vector columns are exact-scanned and both full-text
  indexes are expression indexes, so deleting a row removes its entry.

## Retention

- OAuth connect states expire and are swept hourly by the worker's retention loop.
- Provider media is kept unless `MEDIA_RETENTION=DELETE_AFTER_READING`, which asks the provider to delete
  its copy once a transcript is stored.
- Revoked credentials keep their row with an encrypted tombstone in place of the secret, for audit.
- Customer facts expire on read rather than being swept; an expired fact is still a row until a deletion
  removes it.

## Export

One contact at a time, admin or owner, capped, and audited in the same transaction as the read. The audit
row carries counts and never content — a row quoting the export would be a second copy of it, sitting
where every admin can read it for ever. A contact in a Business Profile the caller cannot see answers the
same way as a contact that does not exist.

## Secrets

Credentials are envelope-encrypted with the workspace, credential id and purpose bound into the
authenticated data, so a row cannot be decrypted under the wrong one. Plaintext exists only in memory,
between a read and the transport that uses it. Nothing logs a token: the logger serializes errors through
an allowlist and never invokes an error's own `toJSON`, which is where HTTP clients expose request config.

## What the model is given

A typed tree of labelled segments, never a rendered string, and never a credential. Every untrusted
segment is sanitized, truncated at 4,000 characters and fenced with a per-request nonce the system prompt
tells the model to treat as data. The history window is bounded, retrieval hits are capped, and nothing
reaches a prompt that was not read for that draft.

## Sensitive profiles

Not implemented in this version. The stricter content, export and memory rules it would apply have
nowhere to show yet — there is no notification surface in this product, so "suppress notification
previews" has nothing to suppress. The flag belongs with the first surface that would honour it.
