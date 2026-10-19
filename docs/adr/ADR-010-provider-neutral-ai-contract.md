# ADR-010: Provider-neutral structured AI contract

**Status:** Accepted (amended 2026-09-16 by the PR #26 architecture review)

## Decision

Keep all model-provider SDKs behind `packages/ai`. `packages/application` owns the provider-neutral boundary contract and validates model output against it with Zod; `packages/domain` consumes only the semantic values that validation maps the result into, and never the contract itself. The amendment below states the ownership in full.

### Amendment — package ownership (PR #26 architecture review)

Dependency direction follows ADR-008: infrastructure implements ports declared by the core.

1. `packages/domain` holds pure semantic types/entities (e.g. `AiDraft`, lead stage and reason concepts). No provider DTOs, no provider SDKs, no dependency on `application` or `ai`.
2. `packages/application` owns the provider-neutral AI ports (`ReplyModel`, `EmbeddingProvider`, and similar) and the runtime boundary schema/DTO (Zod) that validates model output. After validation it maps the result into pure domain values/entities.
3. `packages/ai` implements those ports with concrete model providers. It may depend on `application`, `domain`, `channel-core` and `observability`; provider SDK types never escape it.

`application` must not depend on `ai`. The reverse direction (`ai -> application`) is the only allowed edge between them; `pnpm lint:boundaries` enforces this.

## Consequences

- model/provider can change without changing conversation/policy logic;
- provider request IDs, usage and latency are normalized telemetry;
- malformed output is never heuristically trusted;
- the model's `should_send` remains advisory and cannot bypass deterministic policy.
