# Task Contract — P2-03 Claude

**Issue:** #10 `[P2-03] Implement provider-neutral AI draft engine`  
**Branch:** `feat/p2-03-ai-draft-engine`  
**Start condition:** Phase 1 core/application contracts stable.  
**Owner:** Claude. Do not merge own PR.

## Read first
`PROJECT_CONTEXT.md`, `AI_BEHAVIOR.md`, `AI_ORCHESTRATION.md`, ADR-010/011, `DATA_MODEL.md`, Issue #10.

## Objective
Implement provider-neutral reply generation with application orchestration that produces schema-valid `AiDraft` records but has zero transport authority.

Package ownership (ADR-010 as amended, enforced by `pnpm lint:boundaries`):
- `packages/application`: the `ReplyModel` port, the Zod model-output boundary schema/DTO, and orchestration that validates output and maps it into domain values;
- `packages/ai`: the concrete provider implementation of `ReplyModel` (may depend on `application`); provider SDKs stay private here;
- `packages/domain`: pure semantic types such as `AiDraft` only;
- `application` must never import `ai` — wire the implementation in `apps/worker`/`apps/web`.

## Required behavior
- `ReplyModel` port declared in `packages/application` hides provider SDK types;
- wire one production provider behind that interface;
- Zod-validated structured output containing reply, confidence, review/send advisory flags, reason codes, intent, lead stage and retrieval/source IDs;
- persist model/provider, prompt version, schema version and normalized usage/latency/request metadata;
- bounded repair/regeneration for malformed model output;
- untrusted conversation/knowledge/style text is data, not instructions;
- model cannot call outbound channel tools or directly enqueue/send a customer message.

## Tests
Valid structured output, malformed JSON, schema mismatch, repair bound exhausted, timeout/provider error, prompt-injection-like user/knowledge text, provider swap fixture and proof that model `should_send` alone cannot cause delivery.

## PR requirements
Document chosen initial provider/model as configuration rather than product architecture. Run root checks/tests. Do not merge.
