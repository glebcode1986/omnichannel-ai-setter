# ADR-018: Logical-operation usage ledger

**Status:** Accepted

## Decision

Customer-facing AI usage is metered by stable logical operations, not raw provider requests/tokens and not delivery attempts.

Primary initial metric: `AI_GENERATION_CYCLES`.

One logical generation cycle can contain bounded provider retry/schema-repair attempts but consumes at most one customer usage unit according to the accepted charge policy.

## Why

Raw provider calls are implementation details and can multiply under retry, schema repair or failover. Charging directly from them makes customer usage unpredictable and couples billing to one model provider.

## Invariants

- every metered logical operation has a stable operation ID;
- duplicate workers/retries cannot charge the same operation twice;
- internal provider token/cost telemetry is stored separately for unit economics;
- hard quota reservation is atomic under concurrency;
- manual human replies and delivery/status retries do not consume AI generation quota;
- failed-generation charge policy is explicit and never inferred from provider retries;
- original ledger entries are append-oriented/auditable; reconciliation uses adjustments rather than silent deletion.

## Consequences

Usage counters may be materialized for speed, but the ledger remains reconstructable/auditable. Future plan pricing can add other usage metrics without redefining provider request semantics.
