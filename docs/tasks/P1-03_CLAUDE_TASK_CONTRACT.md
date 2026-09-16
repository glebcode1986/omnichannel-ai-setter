# Task Contract — P1-03 Claude

**Executor:** Claude Code  
**Issue:** #4 `[P1-03] Implement Prisma schema, Auth.js persistence and workspace isolation`  
**Branch:** `feat/p1-03-prisma-auth-workspaces`  
**Depends on:** accepted #2 and #3  
**Merge authority:** Human/project owner after review; Claude must not merge its own PR.

## Mandatory reading order

1. `PROJECT_CONTEXT.md`
2. `docs/handoff/CURRENT_HANDOFF.md`
3. `AGENTS.md`
4. `CLAUDE.md`
5. `docs/adr/ADR-005-prisma-bullmq-core-stack.md`
6. `docs/adr/ADR-009-authjs-workspaces.md`
7. `docs/specs/DATA_MODEL.md`
8. `docs/specs/REPOSITORY_LAYOUT.md`
9. GitHub Issue #4

## Objective

Implement the initial durable PostgreSQL/Prisma model, Auth.js persistence and explicit workspace tenancy without leaking ORM concepts into pure domain packages.

## Owned scope

- `packages/db`
- minimal Auth.js persistence/session wiring in `apps/web`
- migration/seed/test helpers required for this issue

## Required persistence model

Implement current-spec equivalents of:

- Auth.js user/account/session/verification entities required by the selected adapter
- Workspace
- WorkspaceMember with roles `OWNER | ADMIN | AGENT`
- ChannelAccount
- Contact
- ContactIdentity
- Conversation
- Message
- AiDraft
- DeliveryJobRecord
- KnowledgeDocument / KnowledgeChunk
- StyleExample
- AutomationPolicy
- any small supporting event/idempotency table needed to enforce source-event uniqueness cleanly

## Tenancy requirements

- every customer-owned aggregate is workspace-scoped directly or transitively;
- repository/service entry points for tenant data require explicit workspace context;
- a user may belong to multiple workspaces;
- active workspace authorization is explicit and testable;
- representative cross-workspace read/write attempts are rejected by application/repository scoping;
- do not rely on UI hiding or guessed current workspace.

## Required constraints/indexes

At minimum:

- stable unique inbound source-event identity per channel account;
- stable/unique platform message identity where the provider guarantees it;
- external identity lookup index;
- conversation inbox/recency indexes;
- last-inbound/scheduled-delivery indexes used by expected queries;
- constraint/state design that prevents one logical draft/action from becoming multiple completed sends;
- audit-preserving FK/delete behavior rather than destructive cascades for message/history data.

## Credentials and secrets

Do not create plaintext long-lived credential fields as the final design. Store an encrypted value/reference abstraction placeholder suitable for later Meta token implementation. Tests/seed data must use fake values only.

## Explicitly forbidden

Do not implement:

- Redis/BullMQ behavior (#5)
- webhook ingestion orchestration (#6)
- concrete Instagram/WhatsApp APIs
- AI draft/retrieval/policy logic
- production secrets or real account data

Do not import Prisma into `packages/domain` or `packages/channel-core`.

## Required verification

- Prisma schema validation/generation succeeds;
- initial migration applies to an empty PostgreSQL database;
- test/seed helpers can create two independent workspaces;
- automated isolation tests demonstrate representative cross-workspace reads/writes cannot succeed through repository/application access paths;
- indexes/uniques required above are covered by schema assertions or integration tests where practical;
- root lint/typecheck/test pass.

## Acceptance checklist

- [ ] empty DB migration succeeds
- [ ] Prisma generate succeeds
- [ ] Auth.js persistence is wired minimally and safely
- [ ] `OWNER | ADMIN | AGENT` membership exists
- [ ] multi-workspace membership is supported
- [ ] tenant-scoped repository/service access is explicit
- [ ] cross-workspace access regression tests exist
- [ ] no plaintext production credential design
- [ ] audit history is not casually cascade-deleted
- [ ] no queue/Meta/AI feature creep
- [ ] deviations from `DATA_MODEL.md` are documented before merge

## PR requirements

Open a focused PR into `main` referencing Issue #4. Include the migration summary, exact verification commands, tenancy test evidence, indexes/constraints introduced and any schema deviation with rationale.

Do not merge the PR.
