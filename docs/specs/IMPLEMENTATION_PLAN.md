# Implementation Plan — Phase 1

**Status:** Ready for implementation  
**Architecture freeze:** 2026-09-16

## Development model

- **ChatGPT** owns product architecture, specifications, acceptance criteria, upstream extraction decisions, architectural review and durable repository memory.
- **Claude** is the primary implementation engineer. It works from one GitHub issue at a time and must follow `CLAUDE.md`, `AGENTS.md`, ADRs and specs.
- **Codex/Astra** is the independent reviewer/test engineer by default: regression tests, concurrency/idempotency checks, security/static review and bounded independent modules. It should not edit the same feature package concurrently with Claude unless explicitly reassigned.

## Dependency graph

```text
#1 upstream extraction map [DONE]
          |
          v
#2 repository scaffold/tooling
          |
          v
#3 domain + channel contracts
        /   \
       v     v
#4 DB/auth   #5 queue/delay
       \     /
        v   v
          #6 webhook ingestion

#7 Codex/Astra review runs across #2–#6
```

## Claude execution protocol

For each implementation issue:

1. Read `PROJECT_CONTEXT.md`, `docs/handoff/CURRENT_HANDOFF.md`, `AGENTS.md`, `CLAUDE.md`, relevant ADRs/specs, then the issue.
2. Create a focused branch named after the issue, e.g. `feat/p1-01-project-skeleton`.
3. Do not solve future issues opportunistically.
4. Add/modify tests required by acceptance criteria.
5. Run root lint/typecheck/test plus affected package tests.
6. Open a PR referencing the issue and summarize architecture-relevant deviations explicitly.
7. Update handoff/spec docs only when the implementation revealed a real behavioral decision or changed project state.
8. Do not merge if a required acceptance criterion is knowingly failing.

## Review protocol

Before merge, review should explicitly verify:

- no architecture boundary violations;
- no cross-workspace data access path;
- idempotency on event ingestion and delivery claims;
- no blind retry after ambiguous provider send;
- no intentional delays in webhook lifecycle;
- schema/runtime validation at external boundaries;
- no committed credentials/private customer data;
- tests cover failure states, not only success paths.

Codex/Astra review should be independent: read the spec first, then the diff. Do not merely validate Claude's explanation.

## Phase 1 issues

### #2 — Scaffold pnpm workspace and baseline tooling

Owner: Claude.  
Output: runnable `apps/web`, runnable `apps/worker`, bounded packages, strict TS, lint/test/env baseline.

### #3 — Domain model and channel contracts

Owner: Claude.  
Output: pure domain types and the frozen `ChannelAdapter` boundary with no infrastructure imports.

### #4 — Prisma/Auth.js/workspace isolation

Owner: Claude.  
Output: initial schema/migration, Auth.js persistence and explicit tenant-scoped repositories/services.

### #5 — BullMQ durable work primitives

Owner: Claude.  
Output: typed jobs for debounce, AI trigger, delayed delivery and reconciliation placeholder with deterministic IDs.

### #6 — Channel-neutral webhook ingestion

Owner: Claude.  
Output: verify -> normalize -> idempotent persist -> conversation update -> enqueue -> fast ACK, tested with a fake adapter.

### #7 — Independent architecture/regression review

Owner: Codex/Astra.  
Output: review evidence and independent regression tests across #2–#6.

## Merge order

Preferred merge order is #2, #3, then #4/#5 in either order, then #6. #7 can add reviews/tests incrementally after each PR. Avoid long-lived branches that drift across multiple milestones.

## Phase 1 exit criteria

Phase 1 is complete when a clean checkout can install/build/test, web and worker start independently, core contracts contain no Meta dependencies, DB enforces durable identities/constraints, workspace isolation is tested, queues support safe durable scheduling, and a fake-channel webhook can travel through the entire ingestion path without an LLM or real Meta credentials.

Only after these conditions are met should Phase 2 real Instagram + AI implementation begin.
