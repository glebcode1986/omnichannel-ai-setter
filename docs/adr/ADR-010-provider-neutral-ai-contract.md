# ADR-010: Provider-neutral structured AI contract

**Status:** Accepted

## Decision

Keep all model-provider SDKs behind `packages/ai`. Application/domain code consumes a normalized structured draft/result contract validated with Zod.

## Consequences

- model/provider can change without changing conversation/policy logic;
- provider request IDs, usage and latency are normalized telemetry;
- malformed output is never heuristically trusted;
- the model's `should_send` remains advisory and cannot bypass deterministic policy.
