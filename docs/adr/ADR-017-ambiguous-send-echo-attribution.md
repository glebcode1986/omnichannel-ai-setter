# ADR-017: Attributing an unmatched outbound echo to an ambiguous send

**Status:** Rejected for MVP by the product owner on 2026-09-20 (PR #72). The canonical record
lives on the docs branch; this file is kept because the implementation it governs is here, and a
rejected option is worth more in the repository than a gap where someone re-proposes it next year.

## Context

ADR-012 forbids retrying a send whose outcome is unknown. ADR-013 says an outbound platform echo that
cannot be correlated to an app operation is manual human activity and pauses automation.

Those two rules meet badly in one case. When a send times out mid-flight, the operation is quarantined as
ambiguous and we never learn our own platform message ID. If the message *did* reach the customer, the
platform sends an outbound echo for it — and because we have no ID to correlate it with, ADR-013 reads it
as a human replying natively and pauses automation.

So today an ambiguous send has two costs: the reconciliation cannot be resolved provider-side (Meta offers
no lookup from a send request to a message), and the echo that would have resolved it instead triggers a
false takeover. Every ambiguous send therefore ends with a review item *and* a paused conversation, and
neither is true.

## Proposal

Treat an unattributed outbound echo as evidence for an ambiguous operation, under conditions narrow enough
that the ADR-013 default still holds everywhere else:

- the conversation has **exactly one** operation in `HELD_AMBIGUOUS` — with two, we cannot tell which, and
  both escalate as they do now;
- the echo's timestamp falls inside that operation's ambiguity window (from the claim to the claim plus
  the transport timeout);
- the echo carries a platform message ID not already attributed to any other operation.

Where all three hold, the operation settles as `SENT` with the echo's identifier, and automation is not
paused. Everywhere else, ADR-013 stands unchanged.

## Why this is a decision and not an implementation detail

It changes what an unattributed echo means, which is the core of ADR-013 — and the two ways of being wrong
are not symmetric:

- **attributing a human's message to our operation** costs a missed takeover pause. It is self-correcting:
  the human's *next* message produces another unattributed echo, now with no ambiguous candidate, and
  automation pauses then;
- **not attributing** costs a false takeover and a dead review item on *every* ambiguous send. It is not
  self-correcting, and it is the behaviour we have today.

The first looks clearly better, but it is a weakening of a human-takeover rule, and CLAUDE.md reserves
those for the product owner rather than for the implementer.

## Decision

**Rejected.** An ambiguous automated send is not settled from an unmatched outbound echo on timing or
window heuristics. The stronger human-takeover invariant is preserved instead:

- a **correlated** echo may settle the app operation it is correlated to;
- an **unmatched** echo is native or manual human activity, and takes over the conversation;
- an **unresolved ambiguous** send is quarantined, reconciled and, failing that, put in front of a person;
- **never** a blind retry.

The reasoning is the asymmetry the proposal understated. A missed takeover is not merely self-correcting
on the next message — it is a window in which automation replies over a human who has already started
answering, in a conversation the business believed a person had taken. Trading a certain protection for a
probabilistic one, to spare a review item, is the wrong direction for a product whose whole promise is
that a human can always take the conversation back.

## What the code does

Exactly this, and it did before the decision. `createOperationEvidencePort` answers `UNKNOWN` for
Instagram, because Meta offers no lookup from a send request to a message, and every unresolvable send
therefore reaches a person after a grace period. Nothing needed changing; what changed is that the
alternative is now a decision on the record rather than an open question.

`docs/specs/RELIABILITY_INCIDENTS.md` states the same rule in its reconciliation section.
