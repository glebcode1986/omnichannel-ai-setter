# Usage Metering Specification — v0.1

Companion to `BILLING_ENTITLEMENTS.md` and `PRICING_PACKAGING.md`. Where that spec says *what* a plan
grants, this one says how consumption of it is counted, and what the counting is allowed to be used for.

## Principle

**A logical operation is counted once, whatever the infrastructure does.** A provider retry, a schema
repair attempt, a queue redelivery, a duplicate worker and a process restart are all the same piece of
work from the customer's point of view, and anything that counted them separately would be billing a
business for our own reliability machinery.

So every write to the ledger carries a `usageOperationId` that is derived from facts fixed *before* the
work starts. The uniqueness constraint `(workspace, metric, usageOperationId)` is what makes the counting
idempotent: not a check in application code, which a second worker can lose a race against, but an index.

## Two kinds of counting, deliberately not one

| | internal metric | customer-facing quota |
|---|---|---|
| example | `AI_GENERATION_CYCLES` | `VOICE_TRANSCRIPTION_SECONDS` |
| why it exists | unit economics, fair-use and abuse detection, anomaly alerting, capacity planning, future packaging | an allowance a plan sells |
| can refuse work | **no** | yes, when exhausted |
| shown to the customer as a balance | no | yes |
| reservation | never | required before the work starts |

The separation is enforced rather than documented: `hasCustomerQuota` is the only thing that decides, and
reserving against an internal metric is **refused** with `NOT_A_QUOTA` rather than quietly succeeding. A
reservation that silently did nothing would be worse than no reservation at all — the caller would believe
it had checked something.

Core AI reply generation is included and unmetered in the initial public plans. That is a commercial
decision, and `AI_GENERATION_CYCLES` being an internal metric is how the code states it: there is no
code path through which an exhausted AI allowance could stop a reply, because no such allowance exists.

Provider token counts and cost telemetry stay where they are, on the draft row. They are measurements of
one provider call; a usage cycle is a logical operation. Summing one to answer a question about the other
is the mistake this split exists to prevent.

## Cycles

A cycle is a period with authoritative boundaries, recorded as a row rather than computed at read time —
so that a counter can never belong to two periods, and so that changing the anchor later cannot silently
re-attribute consumption that has already happened.

- Monthly, anchored on the subscription's own day of month.
- `[startsAt, endsAt)`: half-open, so consecutive cycles neither overlap nor leave a gap. An operation
  recorded at exactly `endsAt` belongs to the next cycle.
- An anchor day the month does not have clamps to that month's last day. A 31st anchor in February is the
  28th (or 29th), and March is the 31st again — the anchor is remembered, not overwritten, because a cycle
  that permanently moved to the 28th would shorten every later month by three days.
- Cycles are per workspace, not per metric: the period is the subscription's, and two metrics resetting on
  different days would make "this month's usage" a question with two answers.

## The ledger

Append-only. Nothing in the product updates or deletes a ledger row; a correction is another row.

Each row records the workspace, the cycle, the metric, a signed amount, the `usageOperationId`, which kind
of event it was (`RECORD`, `RESERVE`, `COMMIT`, `RELEASE`), and what it was about. The ledger is the record
of truth; `usage_counters` are a materialized convenience, and `reconcileUsageCounters` recomputes them
from the ledger and reports every difference rather than silently repairing one — a counter that healed
itself would hide the bug that broke it.

## Reservation

For a metric with a customer-facing quota, work that may consume an unknown amount reserves first:

1. **reserve** — under a row lock on the counter, so the last unit cannot be sold twice. Refused with
   `EXHAUSTED` when `committed + reserved + amount` exceeds the allowance.
2. **commit** — the amount actually consumed, which for transcription is known only afterwards. A commit
   larger than the reservation is still recorded in full: the work happened, and a ledger that recorded
   less than was consumed would understate our own costs. It can push a counter past the allowance, which
   is what makes the *next* reservation fail; no overage is charged, per the accepted commercial policy.
3. **release** — for work that did not happen. A reservation nobody settles expires, and expiry releases
   it; otherwise a crashed worker would hold a business's allowance until the cycle ended.

Commit and release are idempotent by the reservation's state: a second commit of the same reservation
returns the first one's outcome rather than counting twice, and a reservation that was already released
cannot be committed afterwards.

## What metering must never do

- Refuse to persist an inbound customer message. Ingestion does not consult the ledger at all.
- Decide a send. The delivery coordinator's gates are safety and policy; an allowance is neither.
- Fail a logical operation because the ledger write failed *after* the work was done. Telemetry is
  recorded in the transaction that records the work where one exists, and is otherwise best-effort and
  logged — the reverse ordering would let a metering outage cost a customer their reply.

## Enforcement

This specification covers the mechanism and the internal telemetry. Wiring refusals into AI generation,
channel capacity and paid transcription is P6-03 (#40), which is where `reserve` acquires its callers.
