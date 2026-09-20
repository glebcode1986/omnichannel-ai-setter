# ADR-017: Attributing an unmatched outbound echo to an ambiguous send

**Status:** Proposed — needs a product-owner decision (Issue #56).

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

## Status of the implementation

Not implemented. `createOperationEvidencePort` answers `UNKNOWN`, which routes every unresolvable send to a
person after a grace period. That is the conservative behaviour and it is correct under ADR-013 as it
stands; this ADR exists so the alternative is a decision someone made rather than a gap nobody noticed.

## Consequences if accepted

- the reconciliation evidence port gains a database-backed implementation reading recent unattributed
  outbound echoes for the conversation;
- ingestion must defer the takeover decision for an outbound echo until the ambiguity check has run, or
  be able to reverse it — a takeover applied and then withdrawn is visible to the operator and must be
  explained in the audit trail;
- ADR-013 is amended rather than replaced: text matching remains insufficient, and correlation by
  operation window becomes an additional, explicitly bounded form of evidence.
