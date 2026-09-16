# Task Contract — P1-02 Claude

**Executor:** Claude Code  
**Issue:** #3 `[P1-02] Implement domain model and channel contracts`  
**Branch:** `feat/p1-02-domain-channel-contracts`  
**Depends on:** merged/accepted #2 scaffold  
**Merge authority:** Human/project owner after review; Claude must not merge its own PR.

## Mandatory reading order

1. `PROJECT_CONTEXT.md`
2. `docs/handoff/CURRENT_HANDOFF.md`
3. `AGENTS.md`
4. `CLAUDE.md`
5. `docs/adr/ADR-001-channel-agnostic-core.md`
6. `docs/adr/ADR-008-pnpm-workspace-layout.md`
7. `docs/specs/CHANNEL_CONTRACTS.md`
8. `docs/specs/DATA_MODEL.md`
9. `docs/specs/REPOSITORY_LAYOUT.md`
10. GitHub Issue #3

## Objective

Implement the pure, channel-neutral domain primitives and the shared channel boundary. This task establishes contracts that later DB, queue, Instagram and WhatsApp code must implement without leaking provider-specific types into the core.

## Owned packages

- `packages/domain`
- `packages/channel-core`

Minimal shared test fixtures may live next to these packages where the scaffold allows.

## Required domain concepts

Implement types/value objects/enums needed by current specs for at least:

- Workspace
- ChannelAccount
- Contact
- ContactIdentity
- Conversation
- Message
- AiDraft
- DeliveryJobRecord
- AutomationPolicy
- HumanTakeoverState
- LeadStage
- AI mode and core message/source/status enums

Do not turn conceptual entities into ORM models here. These are pure domain/application-facing contracts.

## Required channel-core contracts

Implement the frozen semantics from `CHANNEL_CONTRACTS.md`, including:

- `ChannelType`
- `ChannelCapabilities`
- normalized event discriminated union
- webhook verification/raw input types
- `WindowDecision`
- `OutboundMessageCommand`
- discriminated `OutboundContent`
- `SendResult` with `ACCEPTED | REJECTED | AMBIGUOUS`
- `ChannelAdapter`

The exact names may only change when required by a documented contradiction; semantics must remain stable.

## External-boundary validation

Add runtime schema validation where normalized external data crosses into core/application code. Prefer Zod at the boundary. Do not make the pure domain layer depend on Meta, Prisma, React, Next.js or any LLM provider SDK.

## Explicitly forbidden

Do not implement:

- Prisma schema/migrations/repositories (#4)
- BullMQ/Redis queues (#5)
- webhook application orchestration (#6)
- Instagram or WhatsApp concrete adapters
- Meta OAuth/API calls
- AI provider/retrieval/policy/delivery logic
- UI features

## Required tests

Cover at least:

- exhaustive normalized-event discrimination;
- valid/invalid external normalized payload validation;
- `WindowDecision` variants;
- `SendResult` ambiguity semantics;
- fixtures proving both Instagram and WhatsApp can satisfy the same adapter contract without adding provider fields to the interface;
- any domain value-object invariants introduced by the implementation.

## Acceptance checklist

- [ ] `packages/domain` contains no Prisma/Meta/React/Next/provider imports
- [ ] `packages/channel-core` contains no concrete Meta API implementation
- [ ] discriminated unions are exhaustive under strict TypeScript
- [ ] runtime validation exists at appropriate external boundaries
- [ ] Instagram and WhatsApp fixture implementations typecheck against the same adapter contract
- [ ] unit tests pass
- [ ] root lint/typecheck/test pass
- [ ] no future-issue business logic was implemented
- [ ] documentation changed only where a genuine ambiguity was discovered

## PR requirements

Open a focused PR into `main` referencing Issue #3. PR body must include exact commands run, contract/type decisions, any deviation from the frozen spec, and an explicit statement that no Prisma/Meta/provider implementation was added.

Do not merge the PR. Issue #4/#5 should not begin until this contract is accepted sufficiently for downstream work.
