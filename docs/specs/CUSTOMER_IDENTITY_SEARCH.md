# Customer identity, search and durable memory

**Status:** Implemented by P3-01 (Issue #54). The MVP primitives only — no cross-channel identity graph
and no fuzzy resolver, per that issue's scope guard.

**Related:** `DATA_MODEL.md`, `PRODUCT_UX.md`, `RETRIEVAL.md`, ADR-009 (authorization).

**Written for this task.** The issue referenced this document and the repository did not contain it. It
records what was built rather than proposing something else; where it states a decision the issue did not
make, the section says so.

## What this layer refuses to be

A system that remembers customers is useful and is one bad decision away from being something nobody
should ship. Four refusals shape every table and function here, and each one lives somewhere it cannot be
forgotten rather than in a comment asking the next writer to be careful.

### 1. Nothing crosses a Business Profile

A `Contact` is canonical **inside one Business Profile**. The same phone number in two profiles is two
unrelated customers.

This is the product decision, not a limitation to be fixed later. A salon and a dental clinic that both
use this product have no relationship, and an identity graph joining their customers would be a thing
neither business asked for and neither customer consented to. It is also the difference between a tool a
business uses and a data broker it unknowingly feeds.

Structurally: every function in `customer-memory-store.ts` takes an authorized `BusinessProfileContext`
and derives its scope from it. `contact_points`, `external_identities`, `customer_facts`,
`customer_preferences`, `conversation_summaries` and `duplicate_contact_candidates` are all keyed by
`(workspace_id, business_profile_id, …)`, and every uniqueness constraint includes both. Two profiles
recording the same number produce two rows, and neither can see the other's.

### 2. Only a person makes memory authoritative

A model may **propose**. A person **confirms**. Nothing else makes an entry authoritative.

`CustomerFact` and `CustomerPreference` arrive at `SUGGESTED` — including entries a colleague typed
themselves, which sounds pedantic and is not: recording a claim and making it the business's memory are
two acts, and the row can name who did the second one.

`readAuthoritativeMemory` returns `ACTIVE` rows only. Model output therefore sits where nothing reading
memory as the business's own can see it.

In the database, not only in the store:

```sql
CHECK (status <> 'ACTIVE' OR (confirmed_by_user_id IS NOT NULL AND confirmed_at IS NOT NULL))
```

An `AI_SUGGESTED` row cannot be made `ACTIVE` by any code path, a migration, or a console session without
naming the member who confirmed it. That is the database-level form of *AI output cannot self-authorize
memory*, and it is why the test for it is written in raw SQL rather than through the store.

A model's proposal must also cite the draft it came from (`customer_facts_ai_provenance_check`), so an
operator can read the reply that produced a claim before believing it.

### 3. Weak matches suggest; they never merge

| Evidence | What happens |
| --- | --- |
| The same value, provider-verified on **both** sides | `ASSOCIATED` — recorded as an evidenced link |
| The same value, provider-verified on one side or neither | `SUGGESTED_DUPLICATE` — a candidate for a person |
| A similar name, a similar number | Nothing. There is no fuzzy matcher. |

`PROVIDER_VERIFIED` is the only level that auto-associates, because it is the only one where somebody
other than the customer vouched for the value. A number a customer typed into a chat is worth recording
and is not proof: people mistype, and people give a partner's number.

**Associating is not merging.** The contacts stay separate records. Nothing in this layer merges two
contacts; manual merge/split remains V1.1 per the issue's scope guard. Verification may only strengthen —
a provider vouching for a number a customer typed is news, a customer retyping a provider-verified number
is not.

A candidate pair is stored id-ordered (`contact_id < other_contact_id`, a CHECK), so one pair is one row
however it was discovered, and an existing candidate is never re-created. A suggestion queue that repeats
itself is one somebody stops reading.

### 4. Some things are not stored at all

`CustomerFactCategory` has five values: `CONTACT_PREFERENCE`, `SERVICE_HISTORY`, `STATED_REQUIREMENT`,
`LOGISTICS`, `CONSENT`.

There is **no value** for an inferred vulnerability, wealth bracket, or psychological or persuasion
profile. That is the strongest form the issue's prohibition can take: a writer cannot store such a fact by
being careless, only by writing a migration that adds an enum value — which is a decision somebody makes
on purpose, in a reviewed diff, and has to defend.

The enum is asserted directly in the test suite, so adding a value fails the build rather than passing
quietly.

## Search is authorization-first

`searchCustomers(db, context, term, options)` finds customers of **this** Business Profile.

There is no parameter a caller can set to widen it. The scope comes from the authorized context rather
than from an argument, and no function in this module accepts a raw workspace id. That is what "cross-BP
data is invisible by default" has to mean at this layer: not a filter somebody could forget, but no way to
express the question.

Fields searched: contact display name, contact points (both the raw spelling and the normalized one, since
an operator pastes what the customer sent rather than what we stored), channel identifiers (username and
platform user id), and external-system ids.

Each hit reports `matchedOn`, so an operator can see **why** somebody came up rather than guessing. One
row per customer, keeping the first reason — four rows for one person is the same answer four times.

An empty term returns nothing rather than everything. A nonsense limit is clamped to between 1 and 100:
a floor because a caller's arithmetic slip should show one customer rather than a blank screen somebody
reads as "no such person", and a ceiling because no operator reads more and without one a caller can pull
every contact the business has in a single query.

### Message text

Message text is searched **only** when the caller passes `includeMessageText: true`.

The issue lists message text among the fields "as supported by current storage", and a business searching
its own correspondence is ordinary. But it is a different question from *who is this*, with different
consequences, so it is a decision at the call site rather than something that happens to every customer's
words whenever an operator types a name. Message hits also rank **after** identity hits: otherwise a
customer actually named Ambiguous is pushed off the end of the list by everybody who ever used the word.

The Inbox's own search (P5-02) never searches message text at all. That is a deliberate difference: the
Inbox search is a filter on a list somebody is already looking at, and this one is an explicit lookup.

## Freshness, supersession and expiry

An entry is `SUGGESTED`, `ACTIVE`, `SUPERSEDED` or `EXPIRED`.

Confirming a fact supersedes the previous `ACTIVE` entry for the same `(contact, category, subject)` in
**one transaction**, because a partial unique index allows exactly one `ACTIVE` per subject and two
statements would either collide or leave memory contradicting itself in between. Memory that contradicts
itself is worse than no memory: an operator cannot tell which half to trust.

Optional expiry, and **expiry is applied on read**:

```
readAuthoritativeMemory → ACTIVE AND (expires_at IS NULL OR expires_at > now)
```

A fact whose expiry has passed is not returned even if nothing has marked it `EXPIRED` yet.
`expireStaleMemory` is housekeeping, not a correctness mechanism — it exists so the history a person reads
matches what the reader sees. A late background job cannot make stale memory authoritative for as long as
it is behind.

## `ConversationSummary` is assistive only

A model's reading of a conversation. One current summary per conversation, replaced rather than
accumulated, carrying the provider and model that produced it — a summary is only as good as what wrote
it. Optional expiry, because ephemeral context should expire.

It has **no confirmation column at all**, and there is no function anywhere that turns a summary into a
fact. A summary cannot become authority by being confirmed, because there is nothing to confirm it with.
Even if somebody wanted to promote one, the categories such a promotion would need mostly do not exist
(§4).

## Deletion

`forgetCustomer` removes contact points, external identities, facts, preferences and duplicate candidates,
and returns counts of what it removed — "we deleted your data" is a claim that should be countable.

It is the **only** way memory goes away. None of these tables cascade from the contact: every foreign key
here is `ON DELETE RESTRICT`, which `constraints.integration.test.ts` holds the whole schema to. A stray
`contact.delete()` therefore fails loudly rather than quietly vaporizing what a business remembers about
somebody, and removal stays an explicit, auditable act.

It deliberately does **not** delete conversations or messages. Deleting a customer's record is not the
same as deleting the business's own correspondence, and conflating them would destroy an audit trail the
business may be required to keep. A flow that must remove correspondence too is a separate, louder
decision than this function.

## What was not built

Per the issue's MVP scope guard:

- no universal cross-channel identity graph;
- no fuzzy or semantic identity resolution;
- manual merge/split UX (V1.1) — the duplicate-candidate boundary is built, the merge is not;
- no UI. The issue's acceptance criteria ask for persisted, application-facing primitives; the surfaces
  that consume them are separate tasks.
