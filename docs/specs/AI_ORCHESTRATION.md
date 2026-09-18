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

## Implementation notes (P2-03)

- **The port returns raw output.** `ReplyGenerationResult.output` is `unknown`, plus normalized telemetry
  (`provider`, `model`, `requestId`, `usage`, `latencyMs`) and an optional `rejection` for a refusal,
  truncation or unreadable body. A provider implementation can never decide that its own output is
  acceptable: `packages/application` owns the Zod schema and validates every result.
- **The request is a typed segment tree, not a prompt string.** Persona and channel hints are trusted
  configuration; inbound messages, history, knowledge chunks and style examples are separate, differently
  typed arrays of labelled segments. Only `packages/ai` renders them, into a system role that contains no
  untrusted text and a user role where every untrusted block is fenced with a per-request nonce. History is
  replayed as labelled data, never as real assistant turns.
- **No tools, ever.** The port has no tool, callback or transport field, and the provider request is sent
  with no `tools` key at all, so "the model cannot call a channel tool" holds by omission. Nothing in the
  result is assignable to an outbound command.
- **Reason codes the model may emit are a strict subset.** Deterministic gate codes (`HUMAN_TAKEOVER`,
  `WINDOW_CLOSED`, `RATE_LIMITED`, …) and `INVALID_MODEL_OUTPUT` are established by the system; a model
  claiming one fails validation rather than entering the audit trail.
- **Sources are checked against what was supplied.** A `factual_source_ids` entry that was not in the
  request is dropped, the draft is marked for review and `MISSING_FACT` is added. Style example IDs can
  never appear there, because style is a different type.
- **One bounded repair.** Malformed output gets exactly one regeneration carrying the issue paths and the
  previous output *as untrusted data*; after that the generation is stored as a `HELD` audit row with
  `INVALID_MODEL_OUTPUT`, null text and every metadata column populated. A provider refusal is never
  repaired or retried.
- **Generation is idempotent.** Each generation has a key derived from conversation, anchor, state version,
  trigger and request ID, unique per Business Profile, so a retried queue job returns the existing draft
  instead of creating a second one.
- **Provider choice is configuration.** The model ID, timeout, output cap and persona come from the worker
  environment; `packages/ai` never reads `process.env`.

## Implementation notes (P2-04)

- Retrieval runs in the worker before generation and hands the engine a list of chunks; the model is given
  facts and never a way to look for them. See `docs/specs/RETRIEVAL.md` implementation notes.
- A retrieval outage does not cancel the generation but does force human review, because the model cannot
  know the corpus was unreachable and therefore cannot account for it.

## Factuality

Pricing, policy, availability, commitments and product claims require either explicit conversation facts or retrieved trusted knowledge. Style memory never counts as factual evidence. Missing material facts must produce a clarifying question or review reason rather than invention.

## Model selection

Architecture is provider-neutral. Phase 2 may ship one production provider first, selected by a bounded benchmark/evaluation issue. Provider choice is configuration, not domain behavior.
