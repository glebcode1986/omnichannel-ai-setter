# Usage Metering Specification — v0.1

## Goal

Track customer-facing usage deterministically and separately from raw provider cost telemetry.

## Customer-facing primary metric

`AI_GENERATION_CYCLES`

One logical AI generation cycle is counted when the product undertakes one requested draft-generation operation for a conversation/review/simulation according to the configured billing rules.

Internal provider retries/repairs for the same logical cycle do not create additional customer usage units.

## Counting rules

### Count once
- successful AI draft generation;
- a generation that reaches the provider and returns a structurally valid draft, regardless of whether deterministic policy later sends, reviews or skips it;
- if commercial policy chooses to count simulation separately, use `SIMULATION_GENERATION_CYCLES` rather than double-counting the normal metric.

### Do not count again
- malformed-output schema repair/regeneration within the same bounded logical operation;
- provider retry caused by a retryable transient error within the same logical operation;
- delayed send execution;
- delivery/status reconciliation;
- manual human replies;
- duplicated queue jobs/webhooks that resolve to the same logical operation ID.

### Failed provider calls

Track provider-attempt/cost telemetry always. Whether a logical customer unit is charged for a terminal failed generation is a commercial policy and must be represented explicitly (`CHARGE_SUCCESS_ONLY` vs another accepted policy). Default implementation should not silently charge failed user-visible generations.

## Stable operation identity

Each billable logical operation has a stable `usageOperationId`. The usage ledger enforces uniqueness per workspace + metric + operation ID.

This ID survives worker retry/restart and is distinct from provider request IDs.

## Ledger over mutable counters

Persist append-oriented usage events/ledger entries as the audit source. Materialized counters may be cached/aggregated for fast reads, but totals must be reconstructable.

Minimum usage event fields:
- workspaceId
- usageCycleId
- metric
- operationId
- quantity
- occurredAt
- source type (`AI_DRAFT`, `SIMULATION`, `TRANSCRIPTION`, etc.)
- related entity IDs when applicable
- billing/plan version snapshot reference

## Concurrency/idempotency

A uniqueness constraint or atomic claim must ensure the same operation cannot increment usage twice under duplicate workers/retries.

If entitlement is checked and usage is consumed concurrently, reservation/commit semantics must prevent two workers from both exceeding a hard remaining quota unknowingly.

Recommended flow for hard quota:
1. atomically reserve one logical unit against current cycle/limit;
2. execute metered work;
3. commit or release reservation according to accepted charging policy;
4. record provider telemetry separately.

## Internal cost telemetry

Track independently for unit economics:
- model provider + model
- input/output tokens
- normalized provider cost when known
- request latency/retry count
- embedding tokens/cost
- transcription seconds/cost
- media/storage where relevant

Internal cost telemetry must never be used as the sole customer invoice truth unless a future pricing model explicitly adopts it.

## Cycle boundaries

Usage cycles come from the normalized subscription/plan billing period or an explicit product cycle. Do not compute period boundaries independently in multiple services/UI components.

Events arriving near a cycle boundary use authoritative server timestamps/operation start policy documented by the billing service.

## Quota state

Expose normalized states:
- `AVAILABLE`
- `WARNING`
- `EXHAUSTED`
- `OVERAGE_ALLOWED`
- `UNMETERED`

The UI may show estimates, but the server performs the authoritative reservation/entitlement check.

## Reconciliation

Provide a reconciliation job/tool that can compare:
- usage ledger totals;
- materialized counters;
- provider telemetry;
- invoice/provider usage submissions if metered billing is later enabled.

Reconciliation fixes counters through auditable adjustments; it never deletes original usage ledger events silently.
