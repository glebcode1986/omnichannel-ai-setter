# ADR-003: Durable Delayed Delivery

**Status:** Accepted

## Decision

Human-like response delays are represented as durable scheduled jobs. Webhook handlers never sleep for debounce or reply delay.

## Why

Long blocking webhooks are fragile, waste resources and complicate retries. Durable jobs survive restarts, support supersession and permit final stale/human-takeover checks.

## Consequences

- debounce and send delays are persisted/reconstructable;
- queue job IDs are deterministic for policy-critical tasks;
- final revalidation occurs after a worker claims a delivery job and before channel send.
