# ADR-017: Ambiguous send and unmatched outbound echo attribution

**Status:** Rejected for MVP / may be revisited with stronger evidence  
**Product-owner decision:** 2026-09-20

## Context

An Instagram send may time out after Meta could already have accepted it. The operation is therefore `HELD_AMBIGUOUS` and must not be blindly retried.

Separately, an outbound platform echo that cannot be correlated to one of our known sends is treated as native/manual human activity and pauses automation.

A proposed optimization was to attribute an unmatched outbound echo to a single ambiguous operation when it falls inside a narrow time window.

## Decision

Do **not** use an unmatched outbound echo as sufficient evidence that an ambiguous automated send succeeded in the MVP.

Preserve the stronger human-safety invariant:

- correlated provider/app outbound echo -> may settle the matching app operation;
- unmatched outbound echo -> human/native activity and takeover semantics continue to apply;
- ambiguous send with no authoritative correlation -> remains quarantined/reconciliation-required and may require human resolution;
- no blind resend.

## Why

The two errors are asymmetric for this product.

A false attribution could misclassify a real human reply as automation and suppress immediate takeover. That violates the product invariant that **human activity always wins**.

A conservative non-attribution may cause a false takeover and extra Review/reconciliation work, but it does not risk an AI continuing after a human has intervened.

For the first commercial release, safety and auditability outweigh removing this operational inconvenience.

## Revisit criteria

A future revision may accept bounded echo attribution only if we have materially stronger evidence, such as:

- provider-supported request/message correlation;
- a stable provider operation identifier;
- another authoritative transport signal that cannot plausibly be a human message;
- or production evidence plus a separately reviewed policy that preserves human-takeover safety.

Text equality, timing proximity alone, or “exactly one ambiguous operation” remain insufficient.

## Consequences

- Instagram provider-side reconciliation may remain `UNKNOWN`.
- Ambiguous operations are surfaced to Review/reconciliation after the grace period.
- An unmatched outbound echo still pauses AI as human activity.
- The reliability layer may improve operator UX around this case, but must not reinterpret it as `SENT` without authoritative evidence.
