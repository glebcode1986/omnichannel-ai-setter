# ADR-012: Atomic delivery claim and ambiguous-send quarantine

**Status:** Accepted

## Decision

Every outbound AI/human-approved action uses one delivery coordinator with durable operation identity, atomic claim before transport send and explicit `AMBIGUOUS` quarantine.

## Why

Queue retries, concurrent clicks/workers and network timeouts can otherwise double-send customer messages.

## Consequences

- no direct channel sends from UI/routes/AI workers outside the coordinator;
- stale SENDING after crash is not assumed unsent;
- ambiguous outcomes require reconciliation or human review, never blind retry.
