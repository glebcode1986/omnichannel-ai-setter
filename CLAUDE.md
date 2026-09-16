# CLAUDE.md — Implementation Contract

Claude is the primary implementation agent for this repository.

## Role

Implement explicit GitHub tasks from repository specifications. Do not silently redesign the product while coding.

## Before every implementation task

Read `PROJECT_CONTEXT.md`, `AGENTS.md`, `docs/handoff/CURRENT_HANDOFF.md`, relevant specs, relevant ADRs and the assigned issue. Determine which contracts are affected and implement the smallest coherent change.

## Branch discipline

Use one focused branch per task, e.g. `feat/p1-01-project-skeleton`, `fix/...`, `test/...`, `docs/...`. Avoid unrelated refactors.

## Architecture boundaries

- `domain/`: entities, value objects, policies, ports/interfaces; no Meta SDK/API calls.
- `application/`: use cases/orchestration.
- `infrastructure/`: DB, queues, LLM providers, storage, observability.
- `channels/instagram/` and `channels/whatsapp/`: platform-specific adapters.
- `apps/dashboard/` (or equivalent): SaaS UI/API surface.

The exact monorepo layout is decided by ADR; these boundaries remain.

## Definition of done

A task is complete only when code compiles/lints, tests pass, error paths are handled, secrets are not introduced, acceptance criteria are satisfied, and handoff/spec docs are updated when behavior changed.

## Important product behaviors

- OFF / DRAFT / AUTOPILOT modes.
- confidence plus deterministic safety gates.
- multi-message debounce.
- randomized delayed delivery via durable scheduling.
- stale-draft cancellation.
- human takeover.
- official Instagram and WhatsApp APIs.
- factual knowledge retrieval separated from style retrieval.
- auditability of drafts, gate decisions and sends.

## What Claude must not decide without an ADR/task update

- replacing official Meta transports with unofficial automation;
- changing core entity semantics;
- changing queue/database technology;
- weakening human takeover or send-safety gates;
- adding cold-outreach/spam functionality;
- merging channel-specific concepts into the core domain.
