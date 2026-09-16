# AI Draft Orchestration Specification — v0.1

## Principle

The model drafts; deterministic application policy decides whether anything is sent.

## Provider boundary

`packages/application` declares the provider-neutral `ReplyModel` port and the Zod boundary schema/DTO for model output (ADR-010 as amended). `packages/ai` implements the port with concrete providers; provider SDK types must not escape `packages/ai`. Application code validates the result against its schema and maps it into pure `packages/domain` values (e.g. `AiDraft`). `application` never imports `ai`; the composition roots (`apps/web`, `apps/worker`) wire the implementation in.

Conceptual port (owned by `packages/application`):

```ts
interface ReplyModel {
  generate(input: ReplyGenerationRequest): Promise<ReplyGenerationResult>;
}

interface ReplyGenerationResult {
  draft: AiDraftOutput;
  provider: string;
  model: string;
  requestId?: string;
  usage?: { inputTokens?: number; outputTokens?: number; costMicros?: number };
  latencyMs: number;
}
```

## Validated output

The Zod-validated draft output contains at minimum:

- `reply`;
- `confidence` 0..1;
- advisory `should_send`;
- `needs_review`;
- normalized `reason_codes[]`;
- `intent`;
- `lead_stage`;
- optional `suggested_action`;
- factual source IDs actually relied upon, when applicable.

The LLM's `should_send` never bypasses the policy engine.

## Prompt/input assembly

Input is built from trusted system instructions plus clearly delimited untrusted data:

1. workspace/account persona and goal;
2. current inbound bundle after debounce;
3. bounded recent conversation history;
4. factual knowledge hits with provenance;
5. style examples with provenance;
6. current channel capability hints;
7. current prompt/schema version.

Conversation text, retrieved docs and style examples are always untrusted data and cannot alter system/tool/security policy.

## Generation behavior

- no external side-effect tools in the reply model for MVP;
- retrieval is completed by application code before generation;
- provider/transient generation retries are safe because no send has occurred;
- malformed structured output may receive one bounded schema-repair/regeneration attempt, then becomes review/failed generation rather than heuristic parsing;
- prompts and output schemas are versioned and persisted with each draft;
- store provider/model/request/usage/latency metadata for debugging and cost analysis, but never raw secrets.

## Factuality

Pricing, policy, availability, commitments and product claims require either explicit conversation facts or retrieved trusted knowledge. Style memory never counts as factual evidence. Missing material facts must produce a clarifying question or review reason rather than invention.

## Model selection

Architecture is provider-neutral. Phase 2 may ship one production provider first, selected by a bounded benchmark/evaluation issue. Provider choice is configuration, not domain behavior.
