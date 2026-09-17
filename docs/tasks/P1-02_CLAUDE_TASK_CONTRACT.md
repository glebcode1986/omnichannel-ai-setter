# Task Contract — P1-02 Claude

**Executor:** Claude Code  
**Issue:** #3 `[P1-02] Implement domain model and channel contracts`  
**Branch:** `feat/p1-02-domain-channel-contracts`  
**Depends on:** P1-01 scaffold exact HEAD accepted as the stack base for current implementation work. Under the temporary asynchronous-Astra protocol, P1-02 may be stacked on the current P1-01 HEAD before P1-01 is merged, but it must not be merged to `main` ahead of its dependency chain.  
**Merge authority:** Human/project owner after required review; Claude must not merge its own PR.

## Mandatory reading order

1. `PROJECT_CONTEXT.md`
2. `docs/handoff/CURRENT_HANDOFF.md`
3. `AGENTS.md`
4. `CLAUDE.md`
5. `docs/adr/ADR-001-channel-agnostic-core.md`
6. `docs/adr/ADR-008-pnpm-workspace-layout.md`
7. `docs/specs/CHANNEL_CONTRACTS.md`
8. `docs/specs/DATA_MODEL.md` — current consolidated model (v0.4 or later)
9. `docs/specs/MVP_RELEASE_SCOPE.md`
10. `docs/specs/IMPLEMENTATION_ROADMAP_CRITICAL_PATH.md`
11. `docs/specs/REPOSITORY_LAYOUT.md`
12. GitHub Issue #3, noting that older entity names/scope in the issue are superseded where the current specs explicitly changed them.

## Objective

Implement the pure, channel-neutral domain primitives and the shared channel boundary required by the near-term runtime. This task establishes contracts that later DB, queue, Instagram and WhatsApp code must implement without leaking provider-specific types into the core.

This is **not** a request to implement every future entity described in the conceptual Data Model. Preserve extension points where useful, but implement narrowly for Phase 1/MVP critical-path needs.

## Owned packages

- `packages/domain`
- `packages/channel-core`

Minimal shared test fixtures may live next to these packages where the scaffold allows.

## Required domain concepts

Implement types/value objects/enums needed by current specs for at least:

- Workspace
- BusinessProfile
- ChannelAccount
- Contact scoped to one Business Profile by default
- ChannelIdentity (the older Issue #3 name `ContactIdentity` is superseded conceptually by the current Data Model; a compatibility alias is optional only if it materially reduces churn)
- minimal ContactPoint primitives needed to represent phone/email identity without provider-specific assumptions
- Conversation carrying Workspace/BP/channel/contact scope plus a state/version anchor suitable for stale-action protection
- Message
- AiDraft / AI-decision anchor primitives needed by later application work
- DeliveryJobRecord / durable delivery-state primitives needed by Phase 1
- AutomationPolicy foundation
- HumanHandoffState / human-takeover primitives
- LeadStage
- AI mode and core message/source/status enums

Do **not** turn conceptual entities into ORM models here. These are pure domain/application-facing contracts.

Do **not** implement booking, billing-provider, public API, prospecting, Admin Operations, media-storage or integration-provider entities in this task merely because they are present in `DATA_MODEL.md`.

## Business Profile invariants required now

The current product architecture uses Business Profile as the primary operational unit inside a Workspace. Domain contracts introduced here must not freeze the old workspace-wide customer model.

At minimum preserve these semantics:

- `ChannelAccount` belongs to a Business Profile as well as its Workspace tenant;
- `Contact` is canonical within one Business Profile by default;
- `Conversation` is scoped to the same Workspace/Business Profile as its Contact and ChannelAccount;
- later persistence must be able to enforce Workspace/BP consistency with composite constraints or equivalent repository invariants;
- no automatic cross-Business-Profile customer identity graph is implied by these contracts.

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

Provider-specific identifiers may appear only in normalized/provider-boundary fields where required; provider-specific business logic must not enter the pure domain.

## External-boundary validation

Add runtime schema validation where normalized external data crosses into core/application code. Prefer Zod at the boundary. Do not make the pure domain layer depend on Meta, Prisma, React, Next.js or any LLM provider SDK.

## Explicitly forbidden

Do not implement:

- Prisma schema/migrations/repositories (#4)
- BullMQ/Redis queues (#5)
- webhook application orchestration (#6)
- Instagram or WhatsApp concrete adapters
- Meta OAuth/API calls
- AI provider/retrieval/policy/delivery implementation
- billing/provider integration
- booking/calendar integrations
- public API/webhook implementation
- UI features
- speculative full implementations of Later/V1.1 concepts

## Required tests

Cover at least:

- exhaustive normalized-event discrimination;
- valid/invalid external normalized payload validation;
- `WindowDecision` variants;
- `SendResult` ambiguity semantics;
- fixtures proving both Instagram and WhatsApp can satisfy the same adapter contract without adding provider business rules to the interface;
- Business Profile/Workspace scoping invariants represented by the domain contracts;
- Conversation state/version anchor semantics needed for stale-action protection;
- any domain value-object invariants introduced by the implementation.

## Acceptance checklist

- [ ] `packages/domain` contains no Prisma/Meta/React/Next/provider imports
- [ ] `packages/channel-core` contains no concrete Meta API implementation
- [ ] Business Profile is represented as an operational scope and the old workspace-wide Contact assumption is not frozen into the new contracts
- [ ] Contact/channel identity naming and semantics follow current `DATA_MODEL.md`
- [ ] discriminated unions are exhaustive under strict TypeScript
- [ ] runtime validation exists at appropriate external boundaries
- [ ] Instagram and WhatsApp fixture implementations typecheck against the same adapter contract
- [ ] state/version anchors can support later stale draft/review/follow-up checks
- [ ] unit tests pass
- [ ] root `pnpm verify` passes on the exact pushed HEAD
- [ ] no future-issue business logic was implemented
- [ ] documentation changed only where a genuine ambiguity/contract update was discovered

## PR / stacked-work requirements

Under the current temporary asynchronous-review protocol:

1. Build P1-02 on the exact current P1-01 stack base unless the human/project instruction changes.
2. Keep the change bounded to P1-02.
3. Open a focused stacked PR against the immediate dependency branch when `main` does not yet contain P1-01. Do not flatten or duplicate the P1-01 diff into a pretend independent PR.
4. After P1-01 merges, rebase/retarget P1-02 cleanly onto the resulting `main` without changing semantics merely to satisfy the stack transition.
5. Do not merge P1-02 ahead of P1-01.
6. PR body must include exact commands run, contract/type decisions, any deviation from the frozen spec, and an explicit statement that no Prisma/Meta/provider implementation was added.

At the end of the iteration, push the exact HEAD and publish:

`CLAUDE_READY_FOR_ASTRA head=<full_sha> task=P1-02`

with a concise verification summary. Claude should then continue to the next dependency-safe task under the current project instruction rather than waiting for Astra. A later Astra `CHANGES_REQUESTED` finding still blocks the affected code from production until fixed and re-reviewed on the new HEAD.
